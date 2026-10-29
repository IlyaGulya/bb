# Task attachment HTTP surface

Attachment upload uses a raw request body at
`POST /api/v1/plugins/tasks/http/attachments/upload`. Raw bytes are the
simplest supported format, but local-auth non-GET plugin routes require JSON,
so upload uses plugin-token auth. Pass the token in `x-bb-plugin-token` (or the
`token` query parameter).

Upload metadata may use query parameters (`taskId` or `commentId`, `fileName`,
and `mime`) or the corresponding `x-task-id`, `x-comment-id`, `x-file-name`,
and `x-mime-type` headers. Exactly one owner is required. The response is
`{ attachmentId, url }`.

The returned local-auth frontend URL is
`GET /api/v1/plugins/tasks/http/attachments/download?attachmentId=...`.
Deletion is
`DELETE /api/v1/plugins/tasks/http/attachments/delete?attachmentId=...` and,
because it is a local-auth non-GET request, must use `Content-Type:
application/json`.

The same authenticated download path accepts `HEAD` and single byte ranges on
`GET`. Valid closed/open-ended/suffix ranges return `206`, `Content-Range`, the
selected `Content-Length` and `Accept-Ranges: bytes`; unsatisfiable ranges return
`416` with `Content-Range: bytes */<size>`. Malformed/multipart ranges or an
unverifiable `If-Range` fall back to the complete representation. HEAD ignores
Range and does not stream the body. Files are opened once and streamed from the
authorized bounded file handle, not copied into whole-file buffers.

Supported inline video MIME types are `video/mp4` and `video/webm`; the bounded
container header must agree with the declared MIME. A mismatched/corrupt header
returns `415`, not a playable-looking HTML response. Unsupported decoders or
later corruption are reported by the browser player; header/container checks
are not decoder or genuine-scenario proof. HTML/XML/SVG are never served as
inline active content. `download=1` explicitly requests an ordinary file
download with its media MIME and attachment disposition, including recovery for
a damaged recording. The 25 MiB upload limit is unchanged.

These are source HTTP contracts; actual owner-auth denial, desktop/mobile
playback/seek and release qualification require the integrated candidate.

