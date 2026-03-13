import { Minimize2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FocusModeExitButtonProps, FocusModeOverlayProps } from "../types";

export function FocusModeOverlay({ isActive, isExiting, onToggle }: FocusModeOverlayProps) {
  if (!isActive) return null;

  return (
    <button
      type="button"
      className={cn(
        "memore-focus-overlay fixed inset-0 bg-black/20 backdrop-blur-sm z-40",
        isExiting ? "opacity-0 pointer-events-none transition-opacity duration-200 ease-out" : "animate-[focus-backdrop-enter_200ms_ease-out]",
      )}
      onClick={isExiting ? undefined : onToggle}
      aria-label="Exit focus mode"
    />
  );
}

export function FocusModeExitButton({ isActive, isExiting, onToggle, title }: FocusModeExitButtonProps) {
  if (!isActive) return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("absolute top-2 right-2 z-10 opacity-60 hover:opacity-100", isExiting && "pointer-events-none")}
      onClick={isExiting ? undefined : onToggle}
      title={title}
      disabled={isExiting}
    >
      <Minimize2Icon className="w-4 h-4" />
    </Button>
  );
}
