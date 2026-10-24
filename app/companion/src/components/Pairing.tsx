import { useState } from "react";
import {
  ArrowRight,
  LoaderCircle,
  Monitor,
  ShieldCheck,
  Info,
  QrCode,
  Search,
  Stethoscope,
} from "lucide-react";
import { api } from "../core/api";
import { isNative, nativeCall } from "../core/native";
import { pairingQR, connectionHelp } from "../core/pairing";
import { Modal } from "./ui";
export default function Pairing({
  onClose,
  onConnected,
  seed,
}: {
  onClose: () => void;
  onConnected: () => void;
  seed?: string;
}) {
  const initial = (() => {
    try {
      return seed ? pairingQR(seed) : null;
    } catch {
      return null;
    }
  })();
  const [address, setAddress] = useState(initial?.origin || ""),
    [pin, setPin] = useState(""),
    [lan, setLan] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [qr, setQr] = useState(initial),
    [diagnostic, setDiagnostic] = useState(""),
    [found, setFound] = useState<{ name: string; origin: string }[]>([]);
  async function scan() {
    try {
      setBusy(true);
      const r = await nativeCall<{ raw: string }>("scanQr");
      const q = pairingQR(r.raw);
      setQr(q);
      setAddress(q.origin);
      setPin("");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "QR unavailable");
    } finally {
      setBusy(false);
    }
  }
  const help = error ? connectionHelp(error) : null;
  return (
    <Modal
      title="Meet your other half."
      subtitle="A revocable connection to your PC. No permanent credential inside the QR."
      onClose={onClose}
    >
      <div className="pair-illustration">
        <span className="pair-device">O</span>
        <span className="pair-line">··········</span>
        <span className="pair-device">
          <Monitor size={26} strokeWidth={1.5} />
        </span>
      </div>
      {isNative() && (
        <div className="button-row">
          <button
            className="button"
            disabled={busy}
            onClick={() => void scan()}
          >
            <QrCode size={17} />
            Scan PC QR
          </button>
          <button
            className="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const list = await nativeCall<
                  { name: string; origin: string }[]
                >("discover", {}, 12000);
                setFound(list);
                setDiagnostic(
                  list.length
                    ? "Verify the PC identity before entering a PIN."
                    : "No advertisement found. Enable LAN discovery on the PC or use QR/manual address.",
                );
              } catch (e) {
                setError(e instanceof Error ? e.message : "Discovery failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            <Search size={17} />
            Find my PC
          </button>
        </div>
      )}
      {found.map((pc) => (
        <button
          className="command-item"
          key={pc.origin}
          onClick={() => {
            setAddress(pc.origin);
            setQr(null);
          }}
        >
          <Monitor size={18} />
          <span>
            <strong>{pc.name}</strong>
            <small>{pc.origin}</small>
          </span>
        </button>
      ))}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await api.pair(
              address,
              pin,
              lan,
              qr ? { code: qr.code, serverId: qr.serverId } : undefined,
            );
            setPin("");
            setQr(null);
            onConnected();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not connect.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field-label" htmlFor="pc-address">
          PC bridge address
        </label>
        <input
          id="pc-address"
          autoFocus
          inputMode="url"
          autoComplete="url"
          placeholder="https://your-pc.example or 192.168.1.12:8787"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setQr(null);
          }}
          disabled={busy}
          required
        />
        {qr ? (
          <p className="info-note">
            <QrCode size={16} />
            Fresh one-time QR loaded. Review the origin and transport below,
            then explicitly connect.
            <button
              type="button"
              className="text-button"
              onClick={() => setQr(null)}
            >
              Use PIN instead
            </button>
          </p>
        ) : (
          <>
            <label className="field-label" htmlFor="pc-pin">
              Dashboard PIN
            </label>
            <input
              id="pc-pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={128}
              placeholder="PIN shown in your PC agent console"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              disabled={busy}
              required
            />
          </>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            checked={lan}
            onChange={(e) => setLan(e.target.checked)}
          />
          <span>
            Allow HTTP on a trusted private LAN/VPN.
            <small>
              HTTP itself is not encrypted. Prefer HTTPS/an encrypted private
              VPN; never expose the bridge publicly.
            </small>
          </span>
        </label>
        {!isNative() && (
          <p className="info-note">
            <Info size={16} />
            Browser preview uses its configured proxy. The APK connects directly
            to the PC origin.
          </p>
        )}
        {help && (
          <div className="form-error" role="alert">
            <strong>{help.title}</strong>
            <p>{error}</p>
            <ul>
              {help.tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        )}
        <button className="button primary full" disabled={busy}>
          {busy ? (
            <LoaderCircle size={18} className="spin" />
          ) : (
            <ArrowRight size={18} />
          )}{" "}
          {busy ? "Connecting…" : "Connect my PC"}
        </button>
      </form>
      <button
        className="text-button"
        disabled={busy || !address.trim()}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const r = await api.diagnose(address, lan);
            setDiagnostic(
              `PC health: ${r.reachable ? "reachable" : "not ready"} · ${r.service} · version ${r.version}. Pairing still requires authentication; nothing was changed.`,
            );
          } catch (e) {
            setError(e instanceof Error ? e.message : "Health check failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Stethoscope size={16} />
        Run Connection Doctor
      </button>
      {diagnostic && (
        <p className="info-note" role="status">
          {diagnostic}
        </p>
      )}
      <p className="trust-note">
        <ShieldCheck size={14} />
        PC agent 3.10.0+ required. No PIN is saved; Android credentials use
        Keystore. Selecting a PC never grants permissions automatically.
      </p>
    </Modal>
  );
}
