export interface EmailAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface SendEmailPayload {
  to: string;
  subject: string;
  bodyText: string;
  attachments: EmailAttachment[];
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function wrapBase64(b64: string, lineLength = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += lineLength) {
    lines.push(b64.slice(i, i + lineLength));
  }
  return lines.join('\r\n');
}

function encodeMimeHeader(value: string): string {
  // Use RFC 2047 UTF-8 Base64 encoding when non-ASCII characters are present.
  if (/^[\x20-\x7E]*$/.test(value)) {
    return value;
  }
  const utf8Bytes = new TextEncoder().encode(value);
  return `=?UTF-8?B?${bytesToBase64(utf8Bytes)}?=`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildMimeMessage(payload: SendEmailPayload): string {
  const boundary = `repofetch_${Date.now()}_${crypto.randomUUID().replace(/-/g, '')}`;
  const bodyBytes = new TextEncoder().encode(payload.bodyText);

  const parts: string[] = [
    `To: ${payload.to}`,
    `Subject: ${encodeMimeHeader(payload.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(bytesToBase64(bodyBytes)),
  ];

  for (const att of payload.attachments) {
    parts.push(
      '',
      `--${boundary}`,
      `Content-Type: ${att.mimeType}; name="${att.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${att.filename}"`,
      '',
      wrapBase64(bytesToBase64(att.bytes))
    );
  }

  parts.push('', `--${boundary}--`, '');
  return parts.join('\r\n');
}

export async function sendEmailWithAttachments(
  accessToken: string,
  payload: SendEmailPayload
): Promise<{ id: string; threadId?: string }> {
  const rawMime = buildMimeMessage(payload);
  const rawBytes = new TextEncoder().encode(rawMime);
  const encodedRaw = bytesToBase64Url(rawBytes);

  const response = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: encodedRaw }),
    }
  );

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Google session expired. Please sign in with Google again.');
    }
    let detail = `HTTP ${response.status}`;
    try {
      const errJson = (await response.json()) as { error?: { message?: string } };
      if (errJson.error?.message) {
        detail = errJson.error.message;
      }
    } catch {
      // Fall back to HTTP status text
    }
    throw new Error(`Failed to send email via Gmail: ${detail}`);
  }

  return (await response.json()) as { id: string; threadId?: string };
}
