import toast from "react-hot-toast";

const isCapacitorAndroid = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    const cap = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor;
    if (cap?.isNativePlatform?.() && cap?.getPlatform?.() === "android") return true;
  } catch {
    // fall through
  }
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes("android") && (ua.includes("wv") || ua.includes("capacitor"));
};

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const guessMimeType = (filename: string): string => {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    zip: "application/zip",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
    txt: "text/plain",
  };
  return map[ext] || "application/octet-stream";
};

async function downloadOnAndroid(url: string, filename: string): Promise<void> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const { Share } = await import("@capacitor/share");

  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const base64Data = arrayBufferToBase64(buffer);

  const result = await Filesystem.writeFile({
    path: filename,
    data: base64Data,
    directory: Directory.Cache,
  });

  await Share.share({
    title: filename,
    url: result.uri,
    dialogTitle: `保存 ${filename}`,
  });
}

function downloadOnDesktop(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 100);
}

export async function downloadFile(url: string, filename: string): Promise<void> {
  try {
    if (isCapacitorAndroid()) {
      await downloadOnAndroid(url, filename);
    } else {
      downloadOnDesktop(url, filename);
    }
  } catch (err) {
    console.error("[Memore] download failed:", err);
    toast.error("保存失败，请重试");
  }
}
