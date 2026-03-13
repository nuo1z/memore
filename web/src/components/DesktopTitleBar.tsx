import { MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

declare global {
  interface Window {
    runtime?: {
      WindowMinimise: () => void;
      WindowToggleMaximise: () => void;
      WindowHide: () => void;
    };
  }
}

const DesktopTitleBar = () => {
  const [isDesktop, setIsDesktop] = useState(() => !!window.runtime);

  useEffect(() => {
    if (isDesktop) return;

    let attempts = 0;
    const maxAttempts = 60;
    const intervalId = setInterval(() => {
      attempts++;
      if (window.runtime) {
        setIsDesktop(true);
        clearInterval(intervalId);
      } else if (attempts >= maxAttempts) {
        clearInterval(intervalId);
      }
    }, 500);

    return () => clearInterval(intervalId);
  }, [isDesktop]);

  const handleMinimize = useCallback(() => window.runtime?.WindowMinimise(), []);
  const handleMaximize = useCallback(() => window.runtime?.WindowToggleMaximise(), []);
  const handleClose = useCallback(() => window.runtime?.WindowHide(), []);

  if (!isDesktop) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 h-8 z-[9999] flex items-center justify-end select-none bg-transparent"
      style={{ "--wails-draggable": "drag" } as React.CSSProperties}
    >
      <div className="flex items-center h-full" style={{ "--wails-draggable": "no-drag" } as React.CSSProperties}>
        <button
          type="button"
          className="h-full w-11 flex items-center justify-center text-muted-foreground hover:bg-muted/60 transition-colors"
          onClick={handleMinimize}
        >
          <MinusIcon className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          className="h-full w-11 flex items-center justify-center text-muted-foreground hover:bg-muted/60 transition-colors"
          onClick={handleMaximize}
        >
          <SquareIcon className="w-3 h-3" />
        </button>
        <button
          type="button"
          className="h-full w-11 flex items-center justify-center text-muted-foreground hover:bg-red-500 hover:text-white transition-colors"
          onClick={handleClose}
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

export default DesktopTitleBar;
