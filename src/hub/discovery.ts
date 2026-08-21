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

async function findHubProcess(): Promise<HubInfo | undefined> {
  const script = `
$procs = Get-CimInstance Win32_Process -Filter "Name='language_server.exe'" |
  Where-Object { $_.CommandLine -like '*subclient_type*hub*' } |
  Select-Object ProcessId, CommandLine
if (-not $procs) { exit 1 }
$proc = $procs | Select-Object -First 1
$cmd = $proc.CommandLine
$hubPid = $proc.ProcessId
$csrf = if ($cmd -match '--csrf_token\\s+([a-f0-9-]+)') { $matches[1] } else { '' }
$ports = Get-NetTCPConnection -OwningProcess $hubPid -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
  Select-Object -ExpandProperty LocalPort
Write-Output "HUBPID=$hubPid"
Write-Output "CSRF=$csrf"
Write-Output "PORTS=$($ports -join ',')"
`;
  const child = spawn('pwsh', ['-NoProfile', '-Command', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
  const code = await new Promise<number>((resolve) => child.on('close', resolve));
  if (code !== 0) return undefined;

  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const pidLine = lines.find((l) => l.startsWith('HUBPID='));
  const csrfLine = lines.find((l) => l.startsWith('CSRF='));
  const portsLine = lines.find((l) => l.startsWith('PORTS='));
  if (!pidLine || !csrfLine || !portsLine) return undefined;

  const csrfToken = csrfLine.slice(5).trim();
  if (!csrfToken) return undefined;
  const ports = portsLine.slice(6).split(',').map((p) => parseInt(p.trim(), 10)).filter((n) => !Number.isNaN(n));

  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { accept: 'text/html' },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      const m = text.match(/csrfToken":"([a-f0-9-]+)"/);
      if (m && m[1] === csrfToken) {
        return { address: `127.0.0.1:${port}`, csrfToken };
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}
