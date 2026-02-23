import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";

type ScanLevel = "success" | "warning" | "error" | "neutral";

type ScanResultState = {
  level: ScanLevel;
  title: string;
  message: string;
  checkedInAt?: string;
};

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const DEFAULT_API_BASE = "https://concorde-api-production.up.railway.app";

function getStoredApiBase(): string {
  const fromStorage = localStorage.getItem("savvio_scanner_api_base");
  if (fromStorage) {
    return fromStorage;
  }

  return import.meta.env.VITE_API_BASE_URL?.trim() || DEFAULT_API_BASE;
}

function normalizeApiBase(raw: string): string {
  return raw.trim().replace(/\/$/, "");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Unable to start camera scanner.";
}

function pickPreferredCamera(devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  if (devices.length === 0) return undefined;

  const rearCameraRegex =
    /(back|rear|environment|traseira|trasera|arriere|arrière|rueck|后置|後置|背面)/i;

  return devices.find((device) => rearCameraRegex.test(device.label)) ?? devices[0];
}

function extractCheckInToken(scannedText: string): string | null {
  const trimmed = scannedText.trim();
  if (!trimmed) return null;

  try {
    const parsedUrl = new URL(trimmed);
    const token = parsedUrl.searchParams.get("token");
    if (token && token.trim().length > 0) {
      return token.trim();
    }
  } catch {
    // Continue fallback parsing.
  }

  const tokenMatch = trimmed.match(/(?:\?|&)token=([^&]+)/i);
  if (tokenMatch?.[1]) {
    return decodeURIComponent(tokenMatch[1]).trim();
  }

  const jwtLike = trimmed.split(".");
  if (jwtLike.length === 3 && jwtLike.every((part) => part.length > 0)) {
    return trimmed;
  }

  return null;
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const processingRef = useRef(false);

  const [apiBaseInput, setApiBaseInput] = useState<string>(getStoredApiBase());
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [activeCameraLabel, setActiveCameraLabel] = useState("");
  const [processing, setProcessing] = useState(false);
  const [manualInput, setManualInput] = useState("");
  const [lastScannedValue, setLastScannedValue] = useState("-");
  const [result, setResult] = useState<ScanResultState>({
    level: "neutral",
    title: "Ready",
    message: "Start scanning to check in attendees."
  });
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  const apiBase = useMemo(() => normalizeApiBase(apiBaseInput), [apiBaseInput]);

  const stopScanner = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setCameraReady(false);
    setActiveCameraLabel("");
  }, []);

  const consumeCheckInToken = useCallback(
    async (token: string) => {
      setProcessing(true);
      setResult({ level: "neutral", title: "Processing", message: "Submitting check-in token..." });

      try {
        const response = await fetch(`${apiBase}/api/v1/public/check-in/consume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token })
        });

        const payload = (await response.json()) as {
          success?: boolean;
          error?: string;
          details?: string;
          data?: {
            alreadyCheckedIn?: boolean;
            checkedInAt?: string;
            userId?: string;
          };
        };

        if (!response.ok || !payload.success) {
          setResult({
            level: "error",
            title: "Check-in failed",
            message: payload.error || payload.details || "Invalid or expired QR code."
          });
          return;
        }

        if (payload.data?.alreadyCheckedIn) {
          setResult({
            level: "warning",
            title: "Already checked in",
            message: "This attendee has already been checked in.",
            checkedInAt: payload.data.checkedInAt
          });
          return;
        }

        setResult({
          level: "success",
          title: "Check-in successful",
          message: "Attendee marked as checked in.",
          checkedInAt: payload.data?.checkedInAt
        });
      } catch (error: unknown) {
        setResult({
          level: "error",
          title: "Scanner error",
          message: getErrorMessage(error)
        });
      } finally {
        setProcessing(false);
      }
    },
    [apiBase]
  );

  const startScanner = useCallback(async () => {
    if (!videoRef.current) return;

    stopScanner();
    setCameraError("");
    setResult({ level: "neutral", title: "Starting", message: "Opening camera..." });

    try {
      const scanner = new BrowserMultiFormatReader();
      const devices = await BrowserMultiFormatReader.listVideoInputDevices();
      const preferredCamera = pickPreferredCamera(devices);
      const selectedDeviceId = preferredCamera?.deviceId;

      const controls = await scanner.decodeFromVideoDevice(
        selectedDeviceId,
        videoRef.current,
        (scanResult, scanError) => {
          if (scanResult && !processingRef.current) {
            processingRef.current = true;

            const scannedText = scanResult.getText();
            setLastScannedValue(scannedText);
            stopScanner();

            const token = extractCheckInToken(scannedText);
            if (!token) {
              setResult({
                level: "error",
                title: "Invalid QR payload",
                message: "Scanned QR does not contain a check-in token."
              });
              processingRef.current = false;
              return;
            }

            void consumeCheckInToken(token).finally(() => {
              processingRef.current = false;
            });
          }

          if (
            scanError &&
            !(scanError instanceof Error && scanError.name === "NotFoundException")
          ) {
            setCameraError(getErrorMessage(scanError));
          }
        }
      );

      controlsRef.current = controls;
      setCameraReady(true);
      setActiveCameraLabel(preferredCamera?.label || "Default camera");
      setResult({ level: "neutral", title: "Scanning", message: "Point camera at attendee QR." });
    } catch (error: unknown) {
      setCameraError(getErrorMessage(error));
      setResult({
        level: "error",
        title: "Camera error",
        message: "Could not start camera. Use manual token input below."
      });
    }
  }, [consumeCheckInToken, stopScanner]);

  const submitManualToken = useCallback(() => {
    const rawInput = manualInput.trim();
    if (!rawInput) {
      setResult({ level: "error", title: "Missing input", message: "Paste a token or QR URL." });
      return;
    }

    const token = extractCheckInToken(rawInput) ?? rawInput;
    setLastScannedValue(rawInput);
    stopScanner();
    void consumeCheckInToken(token);
  }, [consumeCheckInToken, manualInput, stopScanner]);

  const saveApiBase = useCallback(() => {
    const normalized = normalizeApiBase(apiBaseInput);
    if (!normalized) {
      setResult({ level: "error", title: "Invalid API base", message: "API base URL cannot be empty." });
      return;
    }

    localStorage.setItem("savvio_scanner_api_base", normalized);
    setApiBaseInput(normalized);
    setResult({ level: "neutral", title: "Saved", message: "API base URL saved for this device." });
  }, [apiBaseInput]);

  const handleInstall = useCallback(async () => {
    if (!installPrompt) return;

    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }, [installPrompt]);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      stopScanner();
    };
  }, [stopScanner]);

  const resultClass = `result result-${result.level}`;

  return (
    <main className="app-shell">
      <header className="header">
        <h1>Savvio Concorde</h1>
        <p>Staff Check-In Scanner</p>
      </header>

      <section className="panel">
        <label className="label" htmlFor="api-base">
          API Base URL
        </label>
        <div className="row">
          <input
            id="api-base"
            className="input"
            type="url"
            value={apiBaseInput}
            onChange={(event) => {
              setApiBaseInput(event.target.value);
            }}
            placeholder="https://concorde-api-production.up.railway.app"
          />
          <button className="btn btn-secondary" type="button" onClick={saveApiBase}>
            Save
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="reader-wrap">
          <video ref={videoRef} className="reader-video" muted playsInline autoPlay />
          {!cameraReady ? <div className="overlay">Camera idle</div> : null}
        </div>

        {activeCameraLabel ? <p className="help-text">Camera: {activeCameraLabel}</p> : null}

        <div className="actions">
          <button className="btn btn-primary" type="button" onClick={() => void startScanner()}>
            Start Scan
          </button>
          <button className="btn btn-secondary" type="button" onClick={stopScanner}>
            Stop
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => {
              processingRef.current = false;
              void startScanner();
            }}
            disabled={processing}
          >
            Scan Next
          </button>
        </div>

        <label className="label" htmlFor="manual-token">
          Manual Token / URL
        </label>
        <div className="row">
          <input
            id="manual-token"
            className="input"
            type="text"
            value={manualInput}
            onChange={(event) => {
              setManualInput(event.target.value);
            }}
            placeholder="Paste token or QR URL"
          />
          <button
            className="btn btn-secondary"
            type="button"
            onClick={submitManualToken}
            disabled={processing}
          >
            Submit
          </button>
        </div>

        {cameraError ? <p className="error-text">Camera issue: {cameraError}</p> : null}
      </section>

      <section className={resultClass}>
        <h2>{result.title}</h2>
        <p>{result.message}</p>
        {result.checkedInAt ? (
          <p className="meta">Timestamp: {new Date(result.checkedInAt).toLocaleString()}</p>
        ) : null}
      </section>

      <section className="panel">
        <p className="label">Last Scanned Value</p>
        <p className="last-value">{lastScannedValue}</p>
      </section>

      {installPrompt ? (
        <button className="btn btn-primary install-btn" type="button" onClick={() => void handleInstall()}>
          Install on Android
        </button>
      ) : null}
    </main>
  );
}
