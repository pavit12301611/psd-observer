"""Starter presets for the "What do you want me to Observe?" wizard.

Each preset is a When → Then template: a sensor set, an instruction for the model,
and the action channel to fire. The wizard turns a preset plus the user's own
words into a fully formed :class:`AgentDef`.
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import AgentDef, ModelSpec, SensorKind, SensorSpec, ToolKind, ToolSpec


@dataclass(frozen=True)
class Preset:
    key: str
    label: str
    sensors: tuple[SensorKind, ...]
    condition: str            # the "When" — what the model must look for
    default_action: ToolKind  # the "Then" channel
    needs_vision: bool = True


PRESETS: list[Preset] = [
    Preset("distracted", "I get distracted", (SensorKind.SCREEN,),
           "the user is on a website or app clearly unrelated to their work (social media, video, shopping)", ToolKind.DESKTOP_NOTIFY),
    Preset("printer_fails", "3D printer fails", (SensorKind.CAMERA,),
           "the 3D print has failed, detached from the bed, or shows spaghetti / stringing disaster", ToolKind.TELEGRAM),
    Preset("battery_low", "Battery is low", (SensorKind.SCREEN_OCR,),
           "a battery warning or a battery percentage below 15% is visible", ToolKind.DESKTOP_NOTIFY, False),
    Preset("hour_passes", "An hour passes", (SensorKind.SCREEN,),
           "more than an hour has passed since the first cycle (compare with the cycle time and memory)", ToolKind.DESKTOP_NOTIFY),
    Preset("tickets", "Tickets become available", (SensorKind.SCREEN_OCR,),
           "the page shows tickets are available / in stock / a buy button is enabled", ToolKind.SMS, False),
    Preset("download_done", "A download finishes", (SensorKind.SCREEN_OCR,),
           "a download or file transfer shows 100% or 'completed'", ToolKind.DESKTOP_NOTIFY, False),
    Preset("person_on_camera", "Someone is on camera", (SensorKind.CAMERA,),
           "a person is visible in the camera frame", ToolKind.DISCORD),
    Preset("render_fails", "A render fails", (SensorKind.SCREEN_OCR,),
           "a render, export or build shows an error or 'failed' status", ToolKind.TELEGRAM, False),
    Preset("github_workflow", "A GitHub workflow finishes", (SensorKind.SCREEN, SensorKind.SCREEN_OCR),
           "a GitHub Actions workflow run has reached a terminal state (success or failure)", ToolKind.TELEGRAM),
    Preset("docker_built", "A Docker image is built", (SensorKind.SCREEN_OCR,),
           "terminal output shows a Docker build finished (Successfully built / naming to docker.io)", ToolKind.DESKTOP_NOTIFY, False),
    Preset("agent_finishes", "An AI agent task finishes", (SensorKind.SCREEN,),
           "an AI assistant or coding agent has stopped working and is waiting for the user", ToolKind.DESKTOP_NOTIFY),
    Preset("ride_arrives", "A ride arrives", (SensorKind.SCREEN,),
           "a ride-hailing app shows the driver has arrived at the pickup point", ToolKind.SMS),
    Preset("meeting_starts", "A meeting starts", (SensorKind.SCREEN_AUDIO,),
           "a meeting has started: greetings, 'can you hear me', or a roll call is heard", ToolKind.DESKTOP_NOTIFY, False),
    Preset("character_dies", "A game character dies", (SensorKind.SCREEN,),
           "the game shows a death / 'you died' / respawn screen", ToolKind.DESKTOP_NOTIFY),
    Preset("steam_ready", "A Steam game is ready", (SensorKind.SCREEN_OCR,),
           "Steam shows a download complete or 'Play' button for a game that was installing", ToolKind.DESKTOP_NOTIFY, False),
]

ACTION_CHOICES: dict[str, ToolKind] = {
    "whatsapp": ToolKind.WHATSAPP,
    "sms": ToolKind.SMS,
    "call": ToolKind.PHONE_CALL,
    "telegram": ToolKind.TELEGRAM,
    "discord": ToolKind.DISCORD,
    "log": ToolKind.DESKTOP_NOTIFY,   # local: desktop notification + event log
    "email": ToolKind.EMAIL,
    "notify": ToolKind.DESKTOP_NOTIFY,
}


def preset_by_key(key: str) -> Preset:
    for p in PRESETS:
        if p.key == key:
            return p
    raise KeyError(key)


def build_agent(
    *,
    name: str,
    observe: str,
    preset_key: str | None = None,
    action: str | None = None,
    model: ModelSpec | None = None,
    interval_s: float = 30.0,
    agent_id: str | None = None,
) -> AgentDef:
    """Turn wizard answers into an :class:`AgentDef`.

    ``observe`` is the user's own sentence ("tell me when my print is done");
    if a preset is chosen its condition is appended so the model has concrete criteria.
    """

    preset = preset_by_key(preset_key) if preset_key else None
    action_kind = ACTION_CHOICES.get(action or "", None) or (preset.default_action if preset else ToolKind.DESKTOP_NOTIFY)
    sensors = list(preset.sensors) if preset else [SensorKind.SCREEN]
    condition = preset.condition if preset else observe
    if preset and observe and observe.strip() and observe.strip().lower() != condition.lower():
        condition = f"{condition}. The user also asked: {observe.strip()}"

    channel_note = {
        ToolKind.DESKTOP_NOTIFY: "Use the desktop_notify tool.",
        ToolKind.TELEGRAM: "Use the telegram tool.",
        ToolKind.DISCORD: "Use the discord tool.",
        ToolKind.WHATSAPP: "Use the whatsapp tool.",
        ToolKind.SMS: "Use the sms tool.",
        ToolKind.PHONE_CALL: "Use the phone_call tool.",
        ToolKind.EMAIL: "Use the email tool.",
    }.get(action_kind, f"Use the {action_kind.value} tool.")

    system_prompt = (
        "You are a monitoring agent. Inspect the observations provided each cycle.\n"
        f"Condition to watch for: {condition}.\n"
        "If the condition is met, respond with a JSON object like:\n"
        '{"triggered": true, "reason": "<short reason>", "actions": '
        f'[{{"tool": "{action_kind.value}", "args": {{"text": "<short alert message>"}}}}]}}\n'
        "Otherwise respond exactly: {\"triggered\": false}\n"
        f"{channel_note}"
    )

    sensor_specs = [SensorSpec(kind=k, enabled=True,
                               options={"lang": "eng"} if k == SensorKind.SCREEN_OCR else {})
                    for k in sensors]
    tool_specs = [ToolSpec(kind=action_kind, enabled=True)]
    if action_kind == ToolKind.DESKTOP_NOTIFY:
        tool_specs.append(ToolSpec(kind=ToolKind.MEMORY, enabled=True))
    model = model or ModelSpec(provider="ollama", endpoint="http://127.0.0.1:11434", model="qwen2.5vl:7b",
                               supports_vision=True)
    if not any(s.kind.is_image for s in sensor_specs):
        model = model.model_copy(update={"supports_vision": False})

    from .app import new_agent_id  # local import avoids a cycle

    return AgentDef(
        id=agent_id or new_agent_id(name),
        name=name.strip() or (preset.label if preset else "New agent"),
        description=observe.strip() or (preset.label if preset else ""),
        enabled=False,
        system_prompt=system_prompt,
        sensors=sensor_specs,
        tools=tool_specs,
        model=model,
        loop_interval_s=float(interval_s),
        tags=[preset.key] if preset else [],
    )


__all__ = ["PRESETS", "ACTION_CHOICES", "Preset", "preset_by_key", "build_agent"]
