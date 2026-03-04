import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserMultiFormatReader,
  type IScannerControls,
} from "@zxing/browser";

type ScanLevel = "success" | "warning" | "error" | "neutral";

type ScanResultState = {
  level: ScanLevel;
  title: string;
  message: string;
  checkedInAt?: string;
};

type FeedbackLevel = Exclude<ScanLevel, "neutral">;
type CheckInInput = { kind: "token" | "reference"; value: string };

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

function isNoCodeDetectedError(error: unknown): boolean {
  if (!error) return false;

  const errorName = error instanceof Error ? error.name : "";
  const errorMessage = error instanceof Error ? error.message : String(error);

  return (
    errorName === "NotFoundException" ||
    /No MultiFormat Readers were able to detect the code/i.test(errorMessage) ||
    /\bnot found\b/i.test(errorMessage)
  );
}

function pickPreferredCamera(
  devices: MediaDeviceInfo[],
): MediaDeviceInfo | undefined {
  if (devices.length === 0) return undefined;

  const rearCameraRegex =
    /(back|rear|environment|traseira|trasera|arriere|arrière|rueck|后置|後置|背面)/i;

  return (
    devices.find((device) => rearCameraRegex.test(device.label)) ?? devices[0]
  );
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

function extractPassReferenceId(scannedText: string): string | null {
  const trimmed = scannedText.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^user-[a-fA-F0-9]{24}-event-[a-fA-F0-9]{24}$/);
  if (!match) {
    return null;
  }

  return trimmed;
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const processingRef = useRef(false);
  const feedbackTimeoutRef = useRef<number | null>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const lastTokenRef = useRef<string>("");
  const lastTokenAtRef = useRef<number>(0);

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
    message: "Start scanning to check in attendees.",
  });
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [flashLevel, setFlashLevel] = useState<FeedbackLevel | null>(null);
  const [toast, setToast] = useState<{
    level: FeedbackLevel;
    text: string;
  } | null>(null);

  const apiBase = useMemo(() => normalizeApiBase(apiBaseInput), [apiBaseInput]);

  const stopScanner = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setCameraReady(false);
    setActiveCameraLabel("");
  }, []);

  const triggerFeedback = useCallback((level: FeedbackLevel, text: string) => {
    if (feedbackTimeoutRef.current) {
      window.clearTimeout(feedbackTimeoutRef.current);
    }
    if (toastTimeoutRef.current) {
      window.clearTimeout(toastTimeoutRef.current);
    }

    setFlashLevel(level);
    setToast({ level, text });

    feedbackTimeoutRef.current = window.setTimeout(() => {
      setFlashLevel(null);
    }, 950);

    toastTimeoutRef.current = window.setTimeout(() => {
      setToast(null);
    }, 1700);
  }, []);

  const consumeCheckInPayload = useCallback(
    async (checkInInput: CheckInInput) => {
      setProcessing(true);
      setResult({
        level: "neutral",
        title: "Processing",
        message: "Submitting check-in...",
      });

      try {
        const response = await fetch(`${apiBase}/v1/public/check-in/consume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            checkInInput.kind === "token"
              ? { token: checkInInput.value }
              : {
                  reference: checkInInput.value,
                  passReferenceId: checkInInput.value,
                },
          ),
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
          const message =
            payload.error || payload.details || "Invalid or expired QR code.";
          setResult({
            level: "error",
            title: "Check-in failed",
            message,
          });
          triggerFeedback("error", message);
          return;
        }

        if (payload.data?.alreadyCheckedIn) {
          const message = "This attendee has already been checked in.";
          setResult({
            level: "warning",
            title: "Already checked in",
            message,
            checkedInAt: payload.data.checkedInAt,
          });
          triggerFeedback("warning", "Already checked in");
          return;
        }

        const message = "Attendee marked as checked in.";
        setResult({
          level: "success",
          title: "Check-in successful",
          message,
          checkedInAt: payload.data?.checkedInAt,
        });
        triggerFeedback("success", "Check-in successful");
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        setResult({
          level: "error",
          title: "Scanner error",
          message,
        });
        triggerFeedback("error", message);
      } finally {
        setProcessing(false);
      }
    },
    [apiBase, triggerFeedback],
  );

  const startScanner = useCallback(async () => {
    if (!videoRef.current) return;

    stopScanner();
    setCameraError("");
    setResult({
      level: "neutral",
      title: "Starting",
      message: "Opening camera...",
    });

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

            const token = extractCheckInToken(scannedText);
            const passReferenceId = token
              ? null
              : extractPassReferenceId(scannedText);
            if (!token && !passReferenceId) {
              setResult({
                level: "error",
                title: "Invalid QR payload",
                message:
                  "Scanned QR does not contain a supported check-in payload.",
              });
              triggerFeedback("error", "Invalid QR payload");
              window.setTimeout(() => {
                processingRef.current = false;
              }, 700);
              return;
            }

            const checkInInput: CheckInInput = token
              ? { kind: "token", value: token }
              : { kind: "reference", value: passReferenceId as string };

            const now = Date.now();
            const isRecentDuplicate =
              `${checkInInput.kind}:${checkInInput.value}` ===
                lastTokenRef.current && now - lastTokenAtRef.current < 2200;
            if (isRecentDuplicate) {
              processingRef.current = false;
              return;
            }

            lastTokenRef.current = `${checkInInput.kind}:${checkInInput.value}`;
            lastTokenAtRef.current = now;

            void consumeCheckInPayload(checkInInput).finally(() => {
              window.setTimeout(() => {
                processingRef.current = false;
              }, 700);
            });
          }

          if (scanError && !isNoCodeDetectedError(scanError)) {
            setCameraError(getErrorMessage(scanError));
          }
        },
      );

      controlsRef.current = controls;
      setCameraReady(true);
      setActiveCameraLabel(preferredCamera?.label || "Default camera");
      setResult({
        level: "neutral",
        title: "Scanning",
        message: "Point camera at attendee QR.",
      });
    } catch (error: unknown) {
      setCameraError(getErrorMessage(error));
      setResult({
        level: "error",
        title: "Camera error",
        message: "Could not start camera. Use manual token input below.",
      });
    }
  }, [consumeCheckInPayload, stopScanner, triggerFeedback]);

  const submitManualToken = useCallback(() => {
    const rawInput = manualInput.trim();
    if (!rawInput) {
      setResult({
        level: "error",
        title: "Missing input",
        message: "Paste a token or QR URL.",
      });
      triggerFeedback("error", "Paste a token or QR URL");
      return;
    }

    const token = extractCheckInToken(rawInput);
    const passReferenceId = token ? null : extractPassReferenceId(rawInput);
    if (!token && !passReferenceId) {
      setResult({
        level: "error",
        title: "Invalid input",
        message: "Input is not a valid token, check-in URL, or pass reference.",
      });
      triggerFeedback("error", "Invalid input payload");
      return;
    }

    const checkInInput: CheckInInput = token
      ? { kind: "token", value: token }
      : { kind: "reference", value: passReferenceId as string };
    setLastScannedValue(rawInput);
    void consumeCheckInPayload(checkInInput);
  }, [consumeCheckInPayload, manualInput, triggerFeedback]);

  const saveApiBase = useCallback(() => {
    const normalized = normalizeApiBase(apiBaseInput);
    if (!normalized) {
      setResult({
        level: "error",
        title: "Invalid API base",
        message: "API base URL cannot be empty.",
      });
      return;
    }

    localStorage.setItem("savvio_scanner_api_base", normalized);
    setApiBaseInput(normalized);
    setResult({
      level: "neutral",
      title: "Saved",
      message: "API base URL saved for this device.",
    });
  }, [apiBaseInput]);

  const handleInstall = useCallback(async () => {
    if (!installPrompt) return;

    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }, [installPrompt]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(display-mode: standalone)");
    const updateStandaloneMode = () => {
      const iosStandalone =
        "standalone" in navigator &&
        Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
      setIsStandalone(mediaQuery.matches || iosStandalone);
    };

    updateStandaloneMode();

    const onBeforeInstallPrompt = (event: Event) => {
      if (isStandalone) {
        return;
      }
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };

    const onDisplayModeChange = () => {
      updateStandaloneMode();
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    mediaQuery.addEventListener("change", onDisplayModeChange);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      mediaQuery.removeEventListener("change", onDisplayModeChange);
      stopScanner();
      if (feedbackTimeoutRef.current) {
        window.clearTimeout(feedbackTimeoutRef.current);
      }
      if (toastTimeoutRef.current) {
        window.clearTimeout(toastTimeoutRef.current);
      }
    };
  }, [isStandalone, stopScanner]);

  useEffect(() => {
    void startScanner();
    return () => {
      stopScanner();
    };
  }, [startScanner, stopScanner]);

  const resultClass = `result result-${result.level}`;

  return (
    <main className="app-shell">
      <header className="header">
        {!isStandalone && installPrompt ? (
          <button
            className="install-icon-btn"
            type="button"
            aria-label="Install scanner app"
            title="Install scanner app"
            onClick={() => void handleInstall()}
          >
            ⤓
          </button>
        ) : null}
        <h1>Savvio Concorde</h1>
        <p>Staff Check-In Scanner</p>
      </header>

      <section className="panel panel-collapsible">
        <details>
          <summary>Scanner Settings</summary>
          <div className="settings-body">
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
              <button
                className="btn btn-secondary"
                type="button"
                onClick={saveApiBase}
              >
                Save
              </button>
            </div>
          </div>
        </details>
      </section>

      <section className="panel">
        <div
          className={`reader-wrap ${flashLevel ? `reader-flash-${flashLevel}` : ""}`}
        >
          <video
            ref={videoRef}
            className="reader-video"
            muted
            playsInline
            autoPlay
          />
          {!cameraReady ? <div className="overlay">Camera idle</div> : null}
        </div>

        {activeCameraLabel ? (
          <p className="help-text">Camera: {activeCameraLabel}</p>
        ) : null}

        <div className="actions">
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void startScanner()}
          >
            Start Camera
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={stopScanner}
          >
            Stop
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

        {cameraError ? (
          <p className="error-text">Camera issue: {cameraError}</p>
        ) : null}
      </section>

      <section className={resultClass}>
        <h2>{result.title}</h2>
        <p>{result.message}</p>
        {result.checkedInAt ? (
          <p className="meta">
            Timestamp: {new Date(result.checkedInAt).toLocaleString()}
          </p>
        ) : null}
      </section>

      <section className="panel">
        <p className="label">Last Scanned Value</p>
        <p className="last-value">{lastScannedValue}</p>
      </section>

      {toast ? (
        <div className={`scan-toast scan-toast-${toast.level}`}>
          {toast.text}
        </div>
      ) : null}
    </main>
  );
}
