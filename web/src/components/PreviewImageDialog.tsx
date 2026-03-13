import { Download, X } from "lucide-react";
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { downloadFile } from "@/utils/download";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imgUrls: string[];
  initialIndex?: number;
}

function PreviewImageDialog({ open, onOpenChange, imgUrls, initialIndex = 0 }: Props) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  useEffect(() => {
    setCurrentIndex(initialIndex);
  }, [initialIndex]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!open) return;

      switch (event.key) {
        case "Escape":
          onOpenChange(false);
          break;
        case "ArrowRight":
          setCurrentIndex((prev) => Math.min(prev + 1, imgUrls.length - 1));
          break;
        case "ArrowLeft":
          setCurrentIndex((prev) => Math.max(prev - 1, 0));
          break;
        default:
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  const handleClose = () => {
    onOpenChange(false);
  };

  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      handleClose();
    }
  };

  const handleDownload = () => {
    const url = imgUrls[safeIndex];
    if (!url) return;
    const segments = url.split("/");
    const filename = segments[segments.length - 1] || "image.png";
    downloadFile(url, filename);
  };

  if (!imgUrls.length) return null;

  const safeIndex = Math.max(0, Math.min(currentIndex, imgUrls.length - 1));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!w-[100vw] !h-[100vh] !max-w-[100vw] !max-h-[100vw] p-0 border-0 shadow-none bg-transparent [&>button]:hidden"
        aria-describedby="image-preview-description"
      >
        {/* Top-right buttons */}
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2">
          <Button
            onClick={handleDownload}
            variant="secondary"
            size="icon"
            className="rounded-full bg-popover/20 hover:bg-popover/30 border-border/20 backdrop-blur-sm"
            aria-label="Save image"
          >
            <Download className="h-4 w-4 text-popover-foreground" />
          </Button>
          <Button
            onClick={handleClose}
            variant="secondary"
            size="icon"
            className="rounded-full bg-popover/20 hover:bg-popover/30 border-border/20 backdrop-blur-sm"
            aria-label="Close image preview"
          >
            <X className="h-4 w-4 text-popover-foreground" />
          </Button>
        </div>

        {/* Image container */}
        <div className="w-full h-full flex items-center justify-center p-4 sm:p-8 overflow-auto" onClick={handleBackdropClick}>
          <img
            src={imgUrls[safeIndex]}
            alt={`Preview image ${safeIndex + 1} of ${imgUrls.length}`}
            className="max-w-full max-h-full object-contain select-none"
            draggable={false}
            loading="eager"
            decoding="async"
          />
        </div>

        <div id="image-preview-description" className="sr-only">
          Image preview dialog. Press Escape to close or click outside the image.
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default PreviewImageDialog;
