import { DownloadIcon } from "lucide-react";
import { Attachment } from "@/types/proto/api/v1/attachment_service_pb";
import { getAttachmentUrl, isMidiFile } from "@/utils/attachment";
import { downloadFile } from "@/utils/download";
import AttachmentIcon from "./AttachmentIcon";

interface Props {
  attachment: Attachment;
  className?: string;
}

const MemoAttachment: React.FC<Props> = (props: Props) => {
  const { className, attachment } = props;
  const attachmentUrl = getAttachmentUrl(attachment);

  const handlePreviewBtnClick = () => {
    window.open(attachmentUrl);
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    downloadFile(attachmentUrl, attachment.filename);
  };

  return (
    <div
      className={`w-auto flex flex-row justify-start items-center text-muted-foreground hover:text-foreground hover:bg-accent rounded px-2 py-1 transition-colors ${className}`}
    >
      {attachment.type.startsWith("audio") && !isMidiFile(attachment.type) ? (
        <audio src={attachmentUrl} controls></audio>
      ) : (
        <>
          <AttachmentIcon className="w-4! h-4! mr-1" attachment={attachment} />
          <span className="text-sm max-w-[256px] truncate cursor-pointer" onClick={handlePreviewBtnClick}>
            {attachment.filename}
          </span>
          <button
            type="button"
            className="ml-1 p-0.5 rounded hover:bg-accent/60 transition-colors"
            onClick={handleDownload}
            title={`下载 ${attachment.filename}`}
          >
            <DownloadIcon className="w-3.5 h-3.5" />
          </button>
        </>
      )}
    </div>
  );
};

export default MemoAttachment;
