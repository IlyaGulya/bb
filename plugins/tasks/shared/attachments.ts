export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

export function attachmentDownloadUrl(attachmentId: string): string {
  return `/api/v1/plugins/tasks/http/attachments/download?attachmentId=${encodeURIComponent(attachmentId)}`;
}

export function attachmentFileDownloadUrl(attachmentId: string): string {
  return `${attachmentDownloadUrl(attachmentId)}&download=1`;
}

export function isVideoMime(mime: string): boolean {
  return mime === "video/mp4" || mime === "video/webm";
}
