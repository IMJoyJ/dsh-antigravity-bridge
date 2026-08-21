import fs from 'node:fs/promises';
import path from 'node:path';

export interface MediaInput {
  type?: 'image' | 'audio' | 'video' | 'document' | 'file';
  path?: string;
  mimeType?: string;
  data?: Buffer | Uint8Array | string; // Buffer, Uint8Array or base64 string
  description?: string;
}

export type PromptItem = string | MediaInput;
export type PromptContent = PromptItem | PromptItem[];

export interface ProtoMediaPart {
  text?: string;
  media?: {
    mimeType: string;
    description?: string;
    data: string; // Base64 string for JSON-RPC wire format
  };
  slashCommand?: {
    name: string;
  };
}

const MIME_EXTENSION_MAP: Record<string, string> = {
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',

  // Documents
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.ts': 'text/plain',
  '.js': 'text/plain',
  '.py': 'text/plain',
  '.c': 'text/plain',
  '.cpp': 'text/plain',
  '.cs': 'text/plain',
  '.go': 'text/plain',
  '.rs': 'text/plain',
  '.java': 'text/plain',

  // Audio
  '.mp3': 'audio/mp3',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/m4a',
  '.aac': 'audio/aac',

  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska'
};

/**
 * Guesses MIME type from file path extension.
 */
export function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_EXTENSION_MAP[ext] || 'application/octet-stream';
}

/**
 * Reads a local file and converts it to a Base64-encoded MediaInput object.
 */
export async function fileToMedia(
  filePath: string,
  options: { mimeType?: string; description?: string } = {}
): Promise<MediaInput> {
  const resolvedPath = path.resolve(filePath);
  const buffer = await fs.readFile(resolvedPath);
  const mimeType = options.mimeType || guessMimeType(resolvedPath);

  return {
    path: resolvedPath,
    mimeType,
    data: buffer.toString('base64'),
    description: options.description || path.basename(resolvedPath)
  };
}

/**
 * Normalizes dynamic PromptContent (strings, file paths, MediaInputs) into Protobuf-compatible UserInput parts.
 */
export async function normalizePromptParts(content: PromptContent): Promise<ProtoMediaPart[]> {
  const items = Array.isArray(content) ? content : [content];
  const parts: ProtoMediaPart[] = [];

  for (const item of items) {
    if (typeof item === 'string') {
      parts.push({ text: item });
    } else if (typeof item === 'object' && item !== null) {
      if (item.path && !item.data) {
        const media = await fileToMedia(item.path, {
          mimeType: item.mimeType,
          description: item.description
        });
        parts.push({
          media: {
            mimeType: media.mimeType || 'application/octet-stream',
            description: media.description,
            data: typeof media.data === 'string' ? media.data : Buffer.from(media.data as Uint8Array).toString('base64')
          }
        });
      } else if (item.data) {
        const base64Data = typeof item.data === 'string'
          ? item.data
          : Buffer.from(item.data as Uint8Array).toString('base64');
        parts.push({
          media: {
            mimeType: item.mimeType || 'application/octet-stream',
            description: item.description,
            data: base64Data
          }
        });
      }
    }
  }

  return parts;
}
