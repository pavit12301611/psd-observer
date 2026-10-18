"""Messaging channels: Telegram, Discord, Twilio (WhatsApp/SMS/voice), SMTP, SendGrid, Pushover, webhook."""

from __future__ import annotations

import smtplib
from email.message import EmailMessage
from typing import Any

from ..llm.base import sanitize_error
from ..models import ToolContext, ToolKind, ToolResult
from ..util import mask_url_credentials
from .base import Tool, http_post, require

MAX_TEXT = 3800  # Telegram caps at 4096; keep margin


def _text(args: dict[str, Any], default: str = "") -> str:
    return str(args.get("text") or args.get("message") or default)[:MAX_TEXT]


def _template(tpl: str, context: ToolContext, args: dict[str, Any]) -> str:
    return (tpl or "").replace("{agent}", context.agent_name).replace("{reason}", str(args.get("reason", "")))


class TelegramTool(Tool):
    kind = ToolKind.TELEGRAM
    network = True

    def _creds(self) -> tuple[str, str]:
        chat = str(self.option("chat_id") or self.config.telegram.chat_id or "")
        return self.config.telegram.bot_token, chat

    def validate(self) -> tuple[bool, str]:
        token, chat = self._creds()
        return require({"telegram.bot_token": token, "telegram.chat_id / options.chat_id": chat})

    def invoke(self, args, context):
        token, chat = self._creds()
        url = f"{self.config.telegram.api_base}/bot{token}/sendMessage"
        r = http_post(url, json={"chat_id": chat, "text": _text(args, "Observer alert")}, timeout=15)
        if r.status_code == 200 and r.json().get("ok"):
            return ToolResult.success("telegram message sent")
        return ToolResult.failure(f"telegram HTTP {r.status_code}: {r.text[:160]}")

    def schema(self):
        return {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}


class DiscordTool(Tool):
    kind = ToolKind.DISCORD
    network = True

    def _url(self) -> str:
        return str(self.option("webhook_url") or self.config.discord.webhook_url or "")

    def validate(self):
        return require({"discord.webhook_url": self._url()})

    def invoke(self, args, context):
        r = http_post(self._url(), json={"content": _text(args, "Observer alert")}, timeout=15)
        if r.status_code in (200, 204):
            return ToolResult.success("discord message sent")
        return ToolResult.failure(f"discord HTTP {r.status_code}: {r.text[:160]}")

    def schema(self):
        return {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}


class TwilioBase(Tool):
    network = True

    def _auth(self) -> tuple[str, str]:
        return self.config.twilio.account_sid, self.config.twilio.auth_token

    def _from(self) -> str:
        return str(self.option("from") or self.config.twilio.from_number or "")

    def _validate_common(self) -> tuple[bool, str]:
        return require({"twilio.account_sid": self._auth()[0], "twilio.auth_token": self._auth()[1],
                        "twilio.from_number": self._from()})

    def _post(self, path: str, data: dict[str, str]) -> ToolResult:
        sid, token = self._auth()
        url = f"{self.config.twilio.api_base}/2010-04-01/Accounts/{sid}/{path}"
        r = http_post(url, data=data, auth=(sid, token), timeout=20)
        if r.status_code in (200, 201):
            return ToolResult.success(f"twilio {path.split('/')[0]} queued", sid=r.json().get("sid", ""))
        return ToolResult.failure(f"twilio HTTP {r.status_code}: {r.text[:160]}")


class WhatsAppTool(TwilioBase):
    kind = ToolKind.WHATSAPP

    def validate(self):
        ok, msg = self._validate_common()
        if not ok:
            return ok, msg
        return require({"options.to": str(self.option("to") or "")})

    def invoke(self, args, context):
        frm = self._from()
        frm = frm if frm.startswith("whatsapp:") else f"whatsapp:{frm}"
        to = str(self.option("to"))
        to = to if to.startswith("whatsapp:") else f"whatsapp:{to}"
        return self._post("Messages.json", {"From": frm, "To": to, "Body": _text(args, "Observer alert")})

    def schema(self):
        return {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}


class SmsTool(TwilioBase):
    kind = ToolKind.SMS

    def validate(self):
        ok, msg = self._validate_common()
        if not ok:
            return ok, msg
        return require({"options.to": str(self.option("to") or "")})

    def invoke(self, args, context):
        return self._post("Messages.json", {"From": self._from(), "To": str(self.option("to")),
                                            "Body": _text(args, "Observer alert")})

    def schema(self):
        return {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}


class PhoneCallTool(TwilioBase):
    kind = ToolKind.PHONE_CALL

    def validate(self):
        ok, msg = self._validate_common()
        if not ok:
            return ok, msg
        return require({"options.to": str(self.option("to") or "")})

    def invoke(self, args, context):
        from xml.sax.saxutils import escape

        say = escape(_text(args, "Observer alert"))
        twiml = f"<Response><Say>{say}</Say></Response>"
        return self._post("Calls.json", {"From": self._from(), "To": str(self.option("to")), "Twiml": twiml})

    def schema(self):
        return {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}


class EmailSmtpTool(Tool):
    kind = ToolKind.EMAIL
    network = True

    def validate(self):
        return require({"smtp.host": self.config.smtp.host,
                        "smtp.from_addr / options.to": str(self.option("to") or self.config.smtp.from_addr or "")})

    def invoke(self, args, context):
        s = self.config.smtp
        msg = EmailMessage()
        msg["From"] = s.from_addr or s.user
        msg["To"] = str(self.option("to"))
        msg["Subject"] = _template(str(self.option("subject_template") or "Observer: {agent}"), context, args)
        msg.set_content(_text(args, "Observer alert"))
        try:
            with smtplib.SMTP(s.host, int(s.port), timeout=s.timeout_s) as smtp:
                if s.use_tls:
                    smtp.starttls()
                if s.user and s.password:
                    smtp.login(s.user, s.password)
                smtp.send_message(msg)
        except Exception as exc:
            return ToolResult.failure(f"smtp failed: {sanitize_error(exc)}")
        return ToolResult.success("email sent")

    def schema(self):
        return {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}


class SendgridTool(Tool):
    kind = ToolKind.EMAIL  # reuses the EMAIL kind via options.provider="sendgrid"
    network = True

    def validate(self):
        return require({"sendgrid.api_key": self.config.sendgrid.api_key,
                        "sendgrid.from_email": self.config.sendgrid.from_email,
                        "options.to": str(self.option("to") or "")})

    def invoke(self, args, context):
        body = {
            "personalizations": [{"to": [{"email": str(self.option("to"))}],
                                  "subject": _template(str(self.option("subject_template") or "Observer: {agent}"), context, args)}],
            "from": {"email": self.config.sendgrid.from_email},
            "content": [{"type": "text/plain", "value": _text(args, "Observer alert")}],
        }
        r = http_post(f"{self.config.sendgrid.api_base}/v3/mail/send", json=body,
                      headers={"Authorization": f"Bearer {self.config.sendgrid.api_key}"}, timeout=20)
        if r.status_code in (200, 202):
            return ToolResult.success("sendgrid accepted")
        return ToolResult.failure(f"sendgrid HTTP {r.status_code}: {r.text[:160]}")

    def schema(self):
        return {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}


class PushoverTool(Tool):
    kind = ToolKind.PUSHOVER
    network = True

    def validate(self):
        return require({"pushover.token": self.config.pushover.token, "pushover.user": self.config.pushover.user})

    def invoke(self, args, context):
        r = http_post("https://api.pushover.net/1/messages.json", data={
            "token": self.config.pushover.token, "user": self.config.pushover.user,
            "message": _text(args, "Observer alert"), "title": context.agent_name or "Observer Core",
        }, timeout=15)
        if r.status_code == 200:
            return ToolResult.success("pushover sent")
        return ToolResult.failure(f"pushover HTTP {r.status_code}: {r.text[:160]}")

    def schema(self):
        return {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}


class HttpWebhookTool(Tool):
    kind = ToolKind.HTTP_WEBHOOK
    network = True

    def validate(self):
        url = str(self.option("url") or "")
        if not url.startswith(("http://", "https://")):
            return False, "options.url must be an http(s) URL"
        return True, "ok"

    def invoke(self, args, context):
        url = str(self.option("url"))
        payload = {"agent": context.agent_id, "text": _text(args, ""), "args": args}
        r = http_post(url, json=payload, timeout=15)
        if 200 <= r.status_code < 300:
            return ToolResult.success(f"webhook {r.status_code}", status=r.status_code)
        return ToolResult.failure(f"webhook HTTP {r.status_code} to {mask_url_credentials(url)}")

    def schema(self):
        return {"type": "object", "properties": {"text": {"type": "string"}, "args": {"type": "object"}}}


__all__ = [
    "TelegramTool", "DiscordTool", "WhatsAppTool", "SmsTool", "PhoneCallTool",
    "EmailSmtpTool", "SendgridTool", "PushoverTool", "HttpWebhookTool",
]
