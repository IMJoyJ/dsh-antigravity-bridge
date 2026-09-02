import { spawn } from 'node:child_process';

export interface HubInfo {
  address: string;
  csrfToken: string;
}

let cached: HubInfo | undefined;

export async function discoverHub(config?: { address?: string; csrfToken?: string }): Promise<HubInfo> {
  if (config?.address && config?.csrfToken) {
    cached = { address: config.address, csrfToken: config.csrfToken };
    return cached;
  }
  if (cached) return cached;

  const info = await findHubProcess();
  if (!info) {
    throw new Error(
      'Antigravity hub not found. Ensure the IDE is running, or set hubAddress + hubCsrfToken in config.'
    );
  }
  cached = info;
  return info;
}

export function clearHubCache() {
  cached = undefined;
}

interface HubCandidate {
  pid: string;
  csrfToken: string;
  ports: number[];
}

async function findHubProcess(): Promise<HubInfo | undefined> {
  // Enumerate ALL matching processes: an Antigravity restart can leave the old
  // language_server.exe behind while the new one is already serving, and the
  // first match is not necessarily the live hub.
  const script = `
$procs = Get-CimInstance Win32_Process -Filter "Name='language_server.exe'" |
  Where-Object { $_.CommandLine -like '*subclient_type*hub*' } |
  Select-Object ProcessId, CommandLine
if (-not $procs) { exit 1 }
foreach ($proc in $procs) {
  $csrf = if ($proc.CommandLine -match '--csrf_token\\s+([a-f0-9-]+)') { $matches[1] } else { '' }
  if (-not $csrf) { continue }
  $ports = Get-NetTCPConnection -OwningProcess $proc.ProcessId -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
    Select-Object -ExpandProperty LocalPort
  Write-Output "PROC=$($proc.ProcessId) CSRF=$csrf PORTS=$($ports -join ',')"
}
`;
  const stdout = await runPowerShell(script);

  const candidates: HubCandidate[] = [];
  for (const line of stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('PROC='))) {
    const pid = line.match(/PROC=(\d+)/)?.[1];
    const csrfToken = line.match(/CSRF=([a-f0-9-]+)/)?.[1] ?? '';
    const ports = (line.match(/PORTS=(.*)/)?.[1] ?? '')
      .split(',')
      .map((p) => parseInt(p.trim(), 10))
      .filter((n) => !Number.isNaN(n));
    if (pid && csrfToken && ports.length > 0) candidates.push({ pid, csrfToken, ports });
  }
  if (candidates.length === 0) return undefined;

  // Validate each candidate by fetching its index page and matching the CSRF
  // token the process was started with; first match wins.
  for (const candidate of candidates) {
    for (const port of candidate.ports) {
      const info = await probeHubPort(port, candidate.csrfToken);
      if (info) return info;
    }
  }
  return undefined;
}

async function probeHubPort(port: number, csrfToken: string): Promise<HubInfo | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return undefined;
    const text = await res.text();
    const m = text.match(/csrfToken":"([a-f0-9-]+)"/);
    if (m && m[1] === csrfToken) {
      return { address: `127.0.0.1:${port}`, csrfToken };
    }
  } catch {
    // Unreachable port — try the next candidate port.
  }
  return undefined;
}

function runPowerShell(script: string): Promise<string> {
  const child = spawn('pwsh', ['-NoProfile', '-Command', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
  });
  let stdout = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
  return new Promise<string>((resolve) => {
    child.on('close', () => resolve(stdout));
  });
}
