import { LatLng } from "leaflet";
import { uniqBy } from "lodash-es";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  FileIcon,
  LinkIcon,
  LoaderIcon,
  type LucideIcon,
  MapPinIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useDebounce } from "react-use";
import { useReverseGeocoding } from "@/components/map";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  useDropdownMenuSubHoverDelay,
} from "@/components/ui/dropdown-menu";
import { triggerMemoreSync } from "@/lib/memore-sync-trigger";
import { useMemoreSyncPreferences } from "@/hooks/useMemoreSyncPreferences";
import { useMemoreSyncRuntimeStatus } from "@/hooks/useMemoreSyncRuntimeStatus";
import type { MemoRelation } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";
import { LinkMemoDialog, LocationDialog } from "../components";
import { useFileUpload, useLinkMemo, useLocation } from "../hooks";
import { useEditorContext } from "../state";
import type { InsertMenuProps } from "../types";
import type { LocalFile } from "../types/attachment";

const InsertMenu = (props: InsertMenuProps) => {
  const t = useTranslate();
  const { state, actions, dispatch } = useEditorContext();
  const { location: initialLocation, onLocationChange, onToggleFocusMode, isUploading: isUploadingProp, showSyncButton } = props;

  const { syncPreferences } = useMemoreSyncPreferences();
  const { runtimeStatus } = useMemoreSyncRuntimeStatus(syncPreferences.remoteServerUrl);

  // 同步状态：根据 backgroundSyncState 和最近错误判断图标与样式
  const syncState = useMemo(() => {
    if (!syncPreferences.enableRemoteSync) return "disabled";
    if (runtimeStatus.backgroundSyncState === "running") return "syncing";
    if (runtimeStatus.lastErrorMessage) return "error";
    if (runtimeStatus.lastPullAt || runtimeStatus.lastPushAt) return "success";
    return "idle";
  }, [syncPreferences.enableRemoteSync, runtimeStatus]);

  // 同步成功后短暂显示绿色勾，3 秒后恢复
  const [showSuccessFlash, setShowSuccessFlash] = useState(false);
  useEffect(() => {
    if (syncState === "success") {
      setShowSuccessFlash(true);
      const timer = setTimeout(() => setShowSuccessFlash(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [runtimeStatus.lastPullAt, runtimeStatus.lastPushAt]);

  const syncTooltip = useMemo(() => {
    if (syncState === "disabled") return t("setting.preference-section.memore-sync.manual-sync");
    if (syncState === "syncing") return t("setting.preference-section.memore-sync.status-background-state") + ": syncing...";
    if (syncState === "error") return `${t("setting.preference-section.memore-sync.status-last-error")}: ${runtimeStatus.lastErrorMessage}`;
    const lastTime = runtimeStatus.lastPushAt || runtimeStatus.lastPullAt;
    if (lastTime) return `${t("setting.preference-section.memore-sync.manual-sync")} (${new Date(lastTime).toLocaleTimeString()})`;
    return t("setting.preference-section.memore-sync.manual-sync");
  }, [syncState, runtimeStatus, t]);

  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [locationDialogOpen, setLocationDialogOpen] = useState(false);
  const [moreSubmenuOpen, setMoreSubmenuOpen] = useState(false);

  const { handleTriggerEnter, handleTriggerLeave, handleContentEnter, handleContentLeave } = useDropdownMenuSubHoverDelay(
    150,
    setMoreSubmenuOpen,
  );

  const { fileInputRef, selectingFlag, handleFileInputChange, handleUploadClick } = useFileUpload((newFiles: LocalFile[]) => {
    newFiles.forEach((file) => dispatch(actions.addLocalFile(file)));
  });

  const linkMemo = useLinkMemo({
    isOpen: linkDialogOpen,
    currentMemoName: props.memoName,
    existingRelations: state.metadata.relations,
    onAddRelation: (relation: MemoRelation) => {
      dispatch(actions.setMetadata({ relations: uniqBy([...state.metadata.relations, relation], (r) => r.relatedMemo?.name) }));
      setLinkDialogOpen(false);
    },
  });

  const location = useLocation(props.location);

  const [debouncedPosition, setDebouncedPosition] = useState<LatLng | undefined>(undefined);

  useDebounce(
    () => {
      setDebouncedPosition(location.state.position);
    },
    1000,
    [location.state.position],
  );

  const { data: displayName } = useReverseGeocoding(debouncedPosition?.lat, debouncedPosition?.lng);

  useEffect(() => {
    if (displayName) {
      location.setPlaceholder(displayName);
    }
  }, [displayName]);

  const isUploading = selectingFlag || isUploadingProp;

  const handleOpenLinkDialog = useCallback(() => {
    setLinkDialogOpen(true);
  }, []);

  const handleLocationClick = useCallback(() => {
    setLocationDialogOpen(true);
    if (!initialLocation && !location.locationInitialized) {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            location.handlePositionChange(new LatLng(position.coords.latitude, position.coords.longitude));
          },
          (error) => {
            console.error("Geolocation error:", error);
          },
        );
      }
    }
  }, [initialLocation, location]);

  const handleLocationConfirm = useCallback(() => {
    const newLocation = location.getLocation();
    if (newLocation) {
      onLocationChange(newLocation);
      setLocationDialogOpen(false);
    }
  }, [location, onLocationChange]);

  const handleLocationCancel = useCallback(() => {
    location.reset();
    setLocationDialogOpen(false);
  }, [location]);

  const handlePositionChange = useCallback(
    (position: LatLng) => {
      location.handlePositionChange(position);
    },
    [location],
  );

  const handleToggleFocusMode = useCallback(() => {
    onToggleFocusMode?.();
    setMoreSubmenuOpen(false);
  }, [onToggleFocusMode]);

  const handleManualSync = useCallback(() => {
    triggerMemoreSync({
      reason: "manual",
      showToast: true,
    });
  }, []);

  const menuItems = useMemo(
    () =>
      [
        {
          key: "upload",
          label: t("common.upload"),
          icon: FileIcon,
          onClick: handleUploadClick,
        },
        {
          key: "link",
          label: t("tooltip.link-memo"),
          icon: LinkIcon,
          onClick: handleOpenLinkDialog,
        },
        {
          key: "location",
          label: t("tooltip.select-location"),
          icon: MapPinIcon,
          onClick: handleLocationClick,
        },
      ] satisfies Array<{ key: string; label: string; icon: LucideIcon; onClick: () => void }>,
    [handleLocationClick, handleOpenLinkDialog, handleUploadClick, t],
  );

  return (
    <>
      <div className="flex flex-row items-center gap-2">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" className="shadow-none" disabled={isUploading}>
              {isUploading ? <LoaderIcon className="size-4 animate-spin" /> : <PlusIcon className="size-4" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {menuItems.map((item) => (
              <DropdownMenuItem key={item.key} onClick={item.onClick}>
                <item.icon className="w-4 h-4" />
                {item.label}
              </DropdownMenuItem>
            ))}
            {/* View submenu with Focus Mode */}
            <DropdownMenuSub open={moreSubmenuOpen} onOpenChange={setMoreSubmenuOpen}>
              <DropdownMenuSubTrigger onPointerEnter={handleTriggerEnter} onPointerLeave={handleTriggerLeave}>
                <MoreHorizontalIcon className="w-4 h-4" />
                {t("common.more")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent onPointerEnter={handleContentEnter} onPointerLeave={handleContentLeave}>
                <DropdownMenuItem onClick={handleToggleFocusMode}>
                  <Maximize2Icon className="w-4 h-4" />
                  {t("editor.focus-mode")}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <div className="px-2 py-1 text-xs text-muted-foreground opacity-80">{t("editor.slash-commands")}</div>
          </DropdownMenuContent>
        </DropdownMenu>

        {showSyncButton && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className={`shadow-none ${syncState === "error" ? "border-destructive/50" : ""}`}
                  onClick={handleManualSync}
                  disabled={syncState === "syncing"}
                >
                  {syncState === "syncing" ? (
                    <RefreshCwIcon className="size-4 animate-spin text-primary" />
                  ) : syncState === "error" ? (
                    <AlertCircleIcon className="size-4 text-destructive" />
                  ) : showSuccessFlash ? (
                    <CheckCircleIcon className="size-4 text-green-500" />
                  ) : (
                    <RefreshCwIcon className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-64 text-xs">
                {syncTooltip}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      {/* Hidden file input */}
      <input
        className="hidden"
        ref={fileInputRef}
        disabled={isUploading}
        onChange={handleFileInputChange}
        type="file"
        multiple={true}
        accept="*"
      />

      <LinkMemoDialog
        open={linkDialogOpen}
        onOpenChange={setLinkDialogOpen}
        searchText={linkMemo.searchText}
        onSearchChange={linkMemo.setSearchText}
        filteredMemos={linkMemo.filteredMemos}
        isFetching={linkMemo.isFetching}
        onSelectMemo={linkMemo.addMemoRelation}
      />

      <LocationDialog
        open={locationDialogOpen}
        onOpenChange={setLocationDialogOpen}
        state={location.state}
        locationInitialized={location.locationInitialized}
        onPositionChange={handlePositionChange}
        onUpdateCoordinate={location.updateCoordinate}
        onPlaceholderChange={location.setPlaceholder}
        onCancel={handleLocationCancel}
        onConfirm={handleLocationConfirm}
      />
    </>
  );
};

export default InsertMenu;
