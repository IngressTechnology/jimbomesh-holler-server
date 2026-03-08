#
# JimboMesh Holler Server - On-Prem Embeddings Installer (Windows)
# JimboMesh Holler Server - On-Prem AI Inference Setup (Windows)
#
# Usage:
#   .\setup.ps1
#   .\setup.ps1 -WithGpu -WithQdrant
#

param(
    [switch]$WithGpu,
    [switch]$CpuOnly,
    [switch]$WithQdrant,
    [switch]$NoStart,
    [switch]$PullOnly,
    [switch]$Help
)

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host ""
    Write-Host "  PowerShell 7+ is required to run this script." -ForegroundColor Yellow
    Write-Host "  You are running PowerShell $($PSVersionTable.PSVersion)" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Install PowerShell 7:" -ForegroundColor Cyan
    Write-Host "    winget install Microsoft.PowerShell" -ForegroundColor White
    Write-Host ""
    Write-Host "  Then re-run this script with:" -ForegroundColor Cyan
    Write-Host "    pwsh .\setup.ps1" -ForegroundColor White
    Write-Host ""
    exit 1
}

# Config
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ImageName = "jimbomesh-still:latest"

# Error handling
$ErrorActionPreference = "Stop"

# Functions
function Write-Banner {
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "                                                                " -ForegroundColor Cyan
    Write-Host "         JIMBOMESH HOLLER SERVER                                " -ForegroundColor Cyan
    Write-Host "         On-Prem AI Embeddings & LLM Service                    " -ForegroundColor Cyan
    Write-Host "                                                                " -ForegroundColor Cyan
    Write-Host "   -------------------------------------------------------------" -ForegroundColor Cyan
    Write-Host "                                                                " -ForegroundColor Cyan
    Write-Host "         https://jimbomesh.ai                                   " -ForegroundColor Cyan
    Write-Host "                                                                " -ForegroundColor Cyan
    Write-Host "   -------------------------------------------------------------" -ForegroundColor Cyan
    Write-Host "                                                                " -ForegroundColor Cyan
    Write-Host "         Made with love by Ingress Technology                   " -ForegroundColor Cyan
    Write-Host "         https://ingresstechnology.ai                           " -ForegroundColor Cyan
    Write-Host "                                                                " -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host ">> $Message" -ForegroundColor Blue
}

function Write-Success {
    param([string]$Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[!!] $Message" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Message)
    Write-Host "[XX] $Message" -ForegroundColor Red
}

function Mask-Key {
    param([string]$Key)
    if ($Key.Length -gt 12) {
        return "$($Key.Substring(0,8))...$($Key.Substring($Key.Length-4))"
    }
    return "****"
}

function Test-Command {
    param([string]$Command)
    try {
        Get-Command $Command -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Repair-StatsSchema {
    $service = "jimbomesh-still"
    $running = docker ps -a --format '{{.Names}}' 2>$null | Where-Object { $_ -eq $service }
    if (-not $running) { return }

    $nodeScript = @'
const Database = require('better-sqlite3');
const dbPath = process.env.SQLITE_DB_PATH || '/opt/jimbomesh-still/data/holler.db';
const db = new Database(dbPath);
try {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='request_stats'").get();
  if (!table) { process.exit(0); }
  const cols = db.prepare("PRAGMA table_info(request_stats)").all().map(function (r) { return r.name; });
  if (cols.indexOf('connection_type') === -1) {
    db.exec('ALTER TABLE request_stats ADD COLUMN connection_type TEXT');
    db.prepare("INSERT OR REPLACE INTO schema_version (version) VALUES (?)").run(4);
    console.log('stats-schema:repaired');
  }
} catch (e) { console.error('stats-schema-error:', e.message); }
db.close();
'@
    try {
        $result = docker exec $service node -e $nodeScript 2>&1
        if ($result -match 'repaired') {
            Write-Success "Repaired legacy request_stats schema (added connection_type column)"
        }
    } catch { <# ignore #> }
}

function Get-EnvVar {
    param(
        [string]$FilePath,
        [string]$Key
    )
    if (-not (Test-Path $FilePath)) { return "" }
    $content = Get-Content $FilePath -Raw
    $match = [regex]::Match($content, "(?m)^$([regex]::Escape($Key))=(.*)$")
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
    return ""
}

function Set-EnvVar {
    param(
        [string]$FilePath,
        [string]$Key,
        [string]$Value
    )
    $line = "$Key=$Value"
    $content = if (Test-Path $FilePath) { Get-Content $FilePath -Raw } else { "" }
    if ($content -match "(?m)^$([regex]::Escape($Key))=") {
        $content = $content -replace "(?m)^$([regex]::Escape($Key))=.*", $line
    } elseif ($content -match "(?m)^#\s*$([regex]::Escape($Key))=") {
        $content = $content -replace "(?m)^#\s*$([regex]::Escape($Key))=.*", $line
    } else {
        if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) {
            $content += "`n"
        }
        $content += $line
    }
    Set-Content -Path $FilePath -Value $content.TrimEnd() -NoNewline
}

function Invoke-Compose {
    param([string[]]$ComposeArgs)
    $composeCheck = docker compose version 2>&1
    if ($LASTEXITCODE -eq 0) {
        & docker compose @ComposeArgs
        if ($LASTEXITCODE -ne 0) {
            throw "docker compose failed: docker compose $($ComposeArgs -join ' ')"
        }
    } elseif (Test-Command docker-compose) {
        & docker-compose @ComposeArgs
        if ($LASTEXITCODE -ne 0) {
            throw "docker-compose failed: docker-compose $($ComposeArgs -join ' ')"
        }
    } else {
        Write-Err "Docker Compose not found"
        exit 1
    }
}

function Invoke-NuclearReset {
    param(
        [string]$ScriptDir,
        [string]$ComposeCmd
    )

    Write-Host ""
    Write-Host "[NUCLEAR OPTION]" -ForegroundColor Red
    Write-Host "-----------------" -ForegroundColor Red
    Write-Host "This will DESTROY:"
    Write-Host "  - All Docker containers and images"
    Write-Host "  - All volumes and cached data"
    Write-Host "  - All configuration files (.env, config)"
    Write-Host "  - SQLite databases"
    Write-Host "  - node_modules/"
    Write-Host "  - All Holler registration data"
    Write-Host ""
    Write-Host "This will KEEP:"
    Write-Host "  - Downloaded Ollama models (expensive to re-download)"
    Write-Host "  - The source code / repo itself"
    Write-Host ""
    Write-Host "WARNING: This action cannot be undone." -ForegroundColor Yellow
    Write-Host ""

    $confirm = Read-Host "Type NUCLEAR to confirm"
    if ($confirm -cne "NUCLEAR") {
        Write-Host ""
        Write-Host "Aborted. Nothing was changed."
        Write-Host ""
        return $false
    }

    # Phase 1
    Write-Host ""
    Write-Host "[NUCLEAR] Stopping all containers..."
    Push-Location $ScriptDir
    try {
        Invoke-Compose @("down", "--remove-orphans")
    } catch {
        Write-Warn "Compose down reported a non-fatal error. Continuing cleanup..."
    }
    Pop-Location

    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -match '^(node|npm|npx)(\.exe)?$' -and
            $_.CommandLine -match 'jimbomesh|holler|api-gateway'
        } |
        ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
        }

    # Phase 2
    Write-Host "[NUCLEAR] Removing Docker images and volumes..."
    $projectNetwork = "jimbomesh-holler_default"
    $networkContainers = docker ps -a --filter "network=$projectNetwork" --format "{{.ID}} {{.Names}} {{.Image}}" 2>$null
    foreach ($row in $networkContainers) {
        if (-not $row) { continue }
        $parts = $row -split '\s+', 3
        $cid = if ($parts.Length -gt 0) { $parts[0] } else { "" }
        $cname = if ($parts.Length -gt 1) { $parts[1] } else { "" }
        $cimage = if ($parts.Length -gt 2) { $parts[2] } else { "" }
        if (($cname -imatch 'ollama') -or ($cimage -imatch 'ollama')) { continue }
        if ($cid) {
            docker stop $cid 2>$null | Out-Null
            docker rm -f $cid 2>$null | Out-Null
        }
    }
    docker network rm $projectNetwork 2>$null | Out-Null

    Push-Location $ScriptDir
    try {
        Invoke-Compose @("down", "--remove-orphans", "--rmi", "local")
    } catch {
        Write-Warn "Compose down --rmi local reported a non-fatal error. Continuing cleanup..."
    }
    Pop-Location

    $projectVolumes = docker volume ls --format "{{.Name}}" | Where-Object { $_ -match 'jimbomesh|holler' }
    foreach ($vol in $projectVolumes) {
        if ($vol -imatch 'ollama') { continue }
        docker volume rm $vol 2>$null | Out-Null
    }

    $relatedImages = docker images --format "{{.Repository}} {{.ID}}" |
        Where-Object { $_ -imatch 'jimbomesh|holler' -and $_ -inotmatch 'ollama' } |
        ForEach-Object { ($_ -split '\s+')[1] } |
        Sort-Object -Unique
    foreach ($img in $relatedImages) {
        if ($img) {
            docker rmi -f $img 2>$null | Out-Null
        }
    }

    # Phase 3
    Write-Host "[NUCLEAR] Wiping data and configuration..."
    $pathsToRemove = @(
        (Join-Path $ScriptDir "data"),
        (Join-Path $ScriptDir "node_modules"),
        (Join-Path $ScriptDir "logs"),
        (Join-Path $ScriptDir "tmp"),
        (Join-Path $ScriptDir "temp"),
        (Join-Path $ScriptDir ".cache"),
        (Join-Path $ScriptDir ".tmp")
    )
    foreach ($p in $pathsToRemove) {
        if (Test-Path $p) {
            Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    $filesToRemove = @(
        ".env",
        ".setup-config.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lockb"
    )
    foreach ($f in $filesToRemove) {
        $fp = Join-Path $ScriptDir $f
        if (Test-Path $fp) {
            Remove-Item $fp -Force -ErrorAction SilentlyContinue
        }
    }

    Get-ChildItem -Path $ScriptDir -Filter "*.lock" -File -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue

    Write-Success "Nuclear cleanup complete. Starting fresh install..."
    Write-Host ""
    return $true
}

function Show-StartupDiagnostics {
    param([string]$ServiceName = "jimbomesh-still")

    Write-Host ""
    Write-Warn "Startup check timed out. Inspecting recent container logs..."

    $logs = docker logs --tail 120 $ServiceName 2>&1
    if ($LASTEXITCODE -ne 0 -or -not $logs) {
        Write-Warn "Could not read logs. Run: docker logs -f $ServiceName"
        return
    }

    $logText = ($logs | Out-String)
    if ($logText -match "SQLITE_READONLY_DIRECTORY" -or $logText -match "readonly database") {
        Write-Err "Detected SQLite permission issue (readonly database)."
        Write-Host "  Quick fix:" -ForegroundColor Yellow
        Write-Host "    docker exec jimbomesh-still sh -lc `"chown -R jimbomesh:jimbomesh /opt/jimbomesh-still/data && chmod 775 /opt/jimbomesh-still/data`"" -ForegroundColor Yellow
        Write-Host "    docker compose restart jimbomesh-still" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "  Recent $ServiceName logs:" -ForegroundColor White
    ($logs | Select-Object -Last 25) | ForEach-Object { Write-Host "    $_" }
}

# Show help
if ($Help) {
    Write-Host "JimboMesh Holler Server - On-Prem Embeddings Installer (Windows)"
    Write-Host ""
    Write-Host "Usage: setup.ps1 [OPTIONS]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -WithGpu         Enable NVIDIA GPU passthrough (skip prompt)"
    Write-Host "  -CpuOnly         Force CPU mode (skip prompt)"
    Write-Host "  -WithQdrant      Include local Qdrant vector database"
    Write-Host "  -NoStart         Don't start services after setup"
    Write-Host "  -PullOnly        Only build the image, don't start"
    Write-Host "  -Help            Show this help message"
    return
}

# Main
Write-Banner

# Detect existing installation
$ExistingInstall = $false
$ContainerRunning = $false
$ImageExists = $false
$envFile = Join-Path $ScriptDir ".env"

$containerCheck = docker ps -a --filter "name=jimbomesh-still" --format "{{.Status}}" 2>$null
if ($containerCheck) { $ExistingInstall = $true }
if ($containerCheck -and $containerCheck -match "^Up") { $ContainerRunning = $true }

$imageCheck = docker images "jimbomesh-still:latest" --format "{{.ID}}" 2>$null
if ($imageCheck) { $ImageExists = $true; $ExistingInstall = $true }

if (Test-Path $envFile) { $ExistingInstall = $true }

if ($ExistingInstall -and -not $PullOnly) {
    Write-Host "  Existing installation detected!" -ForegroundColor Yellow
    Write-Host ""
    if ($ContainerRunning) {
        Write-Host "  Container: " -NoNewline -ForegroundColor White
        Write-Host "running" -ForegroundColor Green
    } elseif ($containerCheck) {
        Write-Host "  Container: " -NoNewline -ForegroundColor White
        Write-Host "stopped" -ForegroundColor Yellow
    }
    if ($ImageExists) {
        Write-Host "  Image:     jimbomesh-still:latest" -ForegroundColor White
    }
    if (Test-Path $envFile) {
        Write-Host "  Config:    .env found" -ForegroundColor White
    }
    Write-Host ""
    Write-Host "  What would you like to do?" -ForegroundColor White
    Write-Host ""
    Write-Host "  1) Update      - Rebuild image + restart (keeps models & data)" -ForegroundColor Cyan
    Write-Host "  2) Restart     - Just restart services (no rebuild)" -ForegroundColor Cyan
    Write-Host "  3) Reconfigure - Re-run setup prompts (GPU, Qdrant) + rebuild" -ForegroundColor Cyan
    Write-Host "  4) Stop        - Shut down all services" -ForegroundColor Cyan
    Write-Host "  5) Quick Start - Continue with guided setup" -ForegroundColor Cyan
    Write-Host "  6) Uninstall   - Remove containers, images, volumes, and config" -ForegroundColor Red
    Write-Host "  7) Nuclear    - Wipe EVERYTHING and start fresh (keeps Ollama models)" -ForegroundColor Red
    Write-Host "  8) Cancel      - Exit without changes" -ForegroundColor Cyan
    Write-Host ""
    $installChoice = Read-Host "  Choose [1-8] (default: 1)"
    if ($installChoice -eq '') { $installChoice = '1' }

    switch ($installChoice) {
        '2' {
            Write-Step "Restarting services..."
            Push-Location $ScriptDir
            Invoke-Compose @("restart", "jimbomesh-still")
            Pop-Location
            Repair-StatsSchema
            Write-Success "Services restarted!"
            Write-Host ""
            Write-Host "  Admin UI:   http://localhost:1920/admin" -ForegroundColor Cyan
            Write-Host "  Logs:       docker logs -f jimbomesh-still" -ForegroundColor Cyan
            Write-Host ""
            exit 0
        }
        '4' {
            Write-Step "Stopping services..."
            Push-Location $ScriptDir
            Invoke-Compose @("down")
            Pop-Location
            Write-Success "All services stopped."
            Write-Host ""
            exit 0
        }
        '6' {
            Write-Host ""
            Write-Host "  WARNING: This will permanently remove:" -ForegroundColor Red
            Write-Host "    - All Docker containers (jimbomesh-still, qdrant)" -ForegroundColor Red
            Write-Host "    - All Docker volumes (downloaded models, SQLite data, Qdrant storage)" -ForegroundColor Red
            Write-Host "    - The Docker image (jimbomesh-still:latest)" -ForegroundColor Red
            Write-Host "    - The .env configuration file" -ForegroundColor Red
            Write-Host ""
            $uninstallConfirm = Read-Host "  Type 'uninstall' to confirm"
            if ($uninstallConfirm -ne 'uninstall') {
                Write-Host ""
                Write-Host "  Uninstall cancelled." -ForegroundColor Yellow
                Write-Host ""
                exit 0
            }
            Write-Host ""
            Write-Step "Stopping and removing containers + volumes..."
            Push-Location $ScriptDir
            Invoke-Compose @("--profile", "qdrant", "down", "-v")
            Pop-Location

            Write-Step "Removing Docker image..."
            docker rmi $ImageName 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Image removed: $ImageName"
            } else {
                Write-Warn "Image not found or already removed"
            }

            Write-Step "Removing configuration files..."
            $filesToRemove = @(".env", ".setup-config.json")
            foreach ($f in $filesToRemove) {
                $fPath = Join-Path $ScriptDir $f
                if (Test-Path $fPath) {
                    Remove-Item $fPath -Force
                    Write-Success "Removed $f"
                }
            }

            Write-Host ""
            Write-Success "JimboMesh Holler Server has been uninstalled."
            Write-Host ""
            Write-Host "  The source code in $ScriptDir is still intact." -ForegroundColor Yellow
            Write-Host "  To reinstall, run: .\setup.ps1" -ForegroundColor Yellow
            Write-Host ""
            exit 0
        }
        '7' {
            $nuclearConfirmed = Invoke-NuclearReset -ScriptDir $ScriptDir -ComposeCmd $ComposeCmd
            if (-not $nuclearConfirmed) {
                exit 0
            }

            # Treat post-nuclear state like a first-time install and continue below.
            $ExistingInstall = $false
            $ContainerRunning = $false
            $ContainerExists = $false
            $ImageExists = $false
            $WithGpu = $false
            $CpuOnly = $false
            $WithQdrant = $false
        }
        '8' {
            Write-Host ""
            Write-Host "  No changes made." -ForegroundColor Yellow
            Write-Host ""
            exit 0
        }
        '5' {
            Write-Step "Running guided quick start setup..."
        }
        '3' {
            Write-Host ""
            Write-Step "Stopping current services..."
            Push-Location $ScriptDir
            Invoke-Compose @("down")
            Pop-Location
            Write-Success "Services stopped. Re-running full setup (models & data on Docker volumes are preserved)..."
        }
        default {
            # Option 1: Update (rebuild + restart, skip GPU/prereq prompts if already configured)
            Write-Step "Updating - rebuilding image..."
            Push-Location $ScriptDir
            Invoke-Compose @("build", "jimbomesh-still")
            Write-Success "Image rebuilt!"
            Write-Step "Restarting with updated code..."
            Invoke-Compose @("up", "-d", "--force-recreate", "--no-deps", "jimbomesh-still")
            Pop-Location
            Repair-StatsSchema
            Write-Success "Update complete! Models and data preserved."
            Write-Host ""

            # Read API key for connect URL
            $connectKey = ""
            $updateGatewayPort = "1920"
            if (Test-Path $envFile) {
                foreach ($line in (Get-Content $envFile)) {
                    if ($line -match '^JIMBOMESH_HOLLER_API_KEY=(.+)$') {
                        $connectKey = $Matches[1].Trim()
                    }
                    if ($line -match '^GATEWAY_PORT=(.+)$') {
                        $updateGatewayPort = $Matches[1].Trim()
                    }
                }
            }
            if ($connectKey) {
                Write-Host "  Connect: http://localhost:$updateGatewayPort/admin#key=$connectKey" -ForegroundColor White
            }
            Write-Host "  Logs:    docker logs -f jimbomesh-still" -ForegroundColor Cyan
            Write-Host ""
            exit 0
        }
    }
}

Write-Step "Checking prerequisites..."

# Check Docker
if (Test-Command docker) {
    Write-Success "docker found"
} else {
    Write-Err "docker not found"
    Write-Host ""
    Write-Host "Docker is required but not installed." -ForegroundColor Red
    Write-Host "Install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/" -ForegroundColor Yellow
    return
}

# Check Docker Compose
$UseComposePlugin = $false
$ComposeCmd = ""
$composeCheck = docker compose version 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Success "Docker Compose found (plugin)"
    $UseComposePlugin = $true
    $ComposeCmd = "docker compose"
} elseif (Test-Command docker-compose) {
    Write-Success "Docker Compose found (standalone)"
    $UseComposePlugin = $false
    $ComposeCmd = "docker-compose"
} else {
    Write-Err "Docker Compose not found"
    Write-Host ""
    Write-Host "Docker Compose is required but not installed." -ForegroundColor Red
    Write-Host "It usually comes with Docker Desktop." -ForegroundColor Yellow
    exit 1
}

# Check Docker is running
try {
    docker info 2>$null | Out-Null
    Write-Success "Docker is running"
} catch {
    Write-Err "Docker is not running"
    Write-Host ""
    Write-Host "Please start Docker Desktop and try again." -ForegroundColor Red
    exit 1
}

# GPU detection and interactive prompt
$HasNvidiaGpu = $false
try {
    $nvidiaCheck = nvidia-smi 2>&1
    if ($LASTEXITCODE -eq 0) { $HasNvidiaGpu = $true }
} catch { }

if (-not $WithGpu -and -not $CpuOnly) {
    Write-Host ""
    if ($HasNvidiaGpu) {
        Write-Success "NVIDIA GPU detected"
        Write-Host ""
        Write-Host "  GPU mode is recommended for much faster inference." -ForegroundColor White
        Write-Host "  Requires: Docker Desktop with WSL2 + NVIDIA Container Toolkit" -ForegroundColor White
        Write-Host ""
        $gpuChoice = Read-Host "  Enable GPU acceleration? [Y/n] (default: Y)"
        if ($gpuChoice -eq '' -or $gpuChoice -match '^[Yy]') {
            $WithGpu = $true
            Write-Success "GPU mode selected"
        } else {
            Write-Host "  CPU mode selected" -ForegroundColor Yellow
        }
    } else {
        Write-Warn "No NVIDIA GPU detected (nvidia-smi not found or failed)"
        Write-Host ""
        Write-Host "  GPU acceleration requires an NVIDIA GPU + Container Toolkit." -ForegroundColor White
        Write-Host "  Install: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/" -ForegroundColor White
        Write-Host ""
        $gpuChoice = Read-Host "  Enable GPU mode anyway? [y/N] (default: N)"
        if ($gpuChoice -match '^[Yy]') {
            $WithGpu = $true
            Write-Warn "GPU mode selected (no GPU detected - may fail)"
        } else {
            Write-Host "  CPU mode selected" -ForegroundColor Yellow
        }
    }
} elseif ($WithGpu) {
    if ($HasNvidiaGpu) {
        Write-Success "NVIDIA GPU detected"
    } else {
        Write-Warn "nvidia-smi not found - GPU passthrough may not work"
        Write-Host "  Install NVIDIA Container Toolkit: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/" -ForegroundColor Yellow
    }
}

# Qdrant interactive prompt
if (-not $WithQdrant) {
    Write-Host ""
    Write-Host "  Qdrant is a local vector database for storing embeddings." -ForegroundColor White
    Write-Host "  Required if you plan to use RAG (retrieval-augmented generation)." -ForegroundColor White
    Write-Host "  Skip if you only need the LLM and embedding API." -ForegroundColor White
    Write-Host ""
    $qdrantChoice = Read-Host "  Include Qdrant vector database? [Y/n] (default: Y)"
    if ($qdrantChoice -eq '' -or $qdrantChoice -match '^[Yy]') {
        $WithQdrant = $true
        Write-Success "Qdrant enabled"
    } else {
        Write-Host "  Qdrant skipped (can add later with: .\setup.ps1 -WithQdrant)" -ForegroundColor Yellow
    }
}

# Create .env if it doesn't exist
Write-Step "Checking configuration..."
$envFile = Join-Path $ScriptDir ".env"
$envExample = Join-Path $ScriptDir ".env.example"
if (-not (Test-Path $envFile)) {
    if (Test-Path $envExample) {
        Copy-Item $envExample $envFile

        # Generate a cryptographically random API key and write it into .env
        $bytes = New-Object byte[] 32
        [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
        $apiKey = ($bytes | ForEach-Object { '{0:x2}' -f $_ }) -join ''
        (Get-Content $envFile -Raw) -replace 'JIMBOMESH_HOLLER_API_KEY=generate_with_openssl_rand_hex_32', "JIMBOMESH_HOLLER_API_KEY=$apiKey" |
            Set-Content $envFile -NoNewline

        # Always generate Qdrant API key so it's ready if Qdrant is enabled later
        $qdrantBytes = New-Object byte[] 32
        [System.Security.Cryptography.RandomNumberGenerator]::Fill($qdrantBytes)
        $qdrantKey = ($qdrantBytes | ForEach-Object { '{0:x2}' -f $_ }) -join ''
        (Get-Content $envFile -Raw) -replace 'QDRANT_API_KEY=generate_with_openssl_rand_hex_32', "QDRANT_API_KEY=$qdrantKey" |
            Set-Content $envFile -NoNewline

        Write-Success "Created .env from .env.example"
        Write-Host ""
        Write-Host "================================================================" -ForegroundColor Yellow
        Write-Host "  YOUR API KEYS (save these - you will need them!):" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  JIMBOMESH_HOLLER_API_KEY=$apiKey" -ForegroundColor White
        Write-Host "  QDRANT_API_KEY=$qdrantKey" -ForegroundColor White
        Write-Host ""
        Write-Host "  Use the API key to:" -ForegroundColor Yellow
        Write-Host "    - Log into the Admin UI at /admin" -ForegroundColor Yellow
        Write-Host "    - Connect to the Holler Server API (X-API-Key header)" -ForegroundColor Yellow
        Write-Host "    - Configure JimboMesh embed.sh" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  Qdrant key is used for vector database authentication." -ForegroundColor Yellow
        Write-Host "  Paste either line directly into .env to update keys." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  Stored in: $envFile" -ForegroundColor Yellow
        Write-Host "================================================================" -ForegroundColor Yellow
    } else {
        Write-Warn "No .env file found - using defaults"
    }
} else {
    Write-Success "Existing .env found - preserving your configuration"
    Write-Host "  To start fresh, delete .env and run setup again" -ForegroundColor Yellow
}

# Auto-generate HOLLER_SERVER_NAME when unset/commented/empty.
$envContent = if (Test-Path $envFile) { Get-Content $envFile -Raw } else { "" }
if ($envContent -notmatch '(?m)^HOLLER_SERVER_NAME=.+' -or $envContent -match '(?m)^HOLLER_SERVER_NAME=Holler Server$') {
    $localHostname = $env:COMPUTERNAME
    if ($envContent -match '(?m)^# *HOLLER_SERVER_NAME=') {
        $envContent = $envContent -replace '(?m)^# *HOLLER_SERVER_NAME=.*', "HOLLER_SERVER_NAME=Holler Server $localHostname"
    } else {
        if ($envContent.Length -gt 0 -and -not $envContent.EndsWith("`n")) {
            $envContent += "`n"
        }
        $envContent += "HOLLER_SERVER_NAME=Holler Server $localHostname"
    }
    Set-Content $envFile $envContent -NoNewline
    Write-Success "Server name set to: Holler Server $localHostname"
}

# Persist defaults/choices so rebuilds/reinstalls keep behavior.
if (-not (Get-EnvVar $envFile "OLLAMA_HOST_PORT")) { Set-EnvVar $envFile "OLLAMA_HOST_PORT" "1920" }
if (-not (Get-EnvVar $envFile "GATEWAY_PORT")) { Set-EnvVar $envFile "GATEWAY_PORT" "1920" }
if (-not (Get-EnvVar $envFile "HOLLER_MODELS")) { Set-EnvVar $envFile "HOLLER_MODELS" "nomic-embed-text,llama3.1:8b" }
if (-not (Get-EnvVar $envFile "OLLAMA_EMBED_MODEL")) { Set-EnvVar $envFile "OLLAMA_EMBED_MODEL" "nomic-embed-text" }
if (-not (Get-EnvVar $envFile "ADMIN_ENABLED")) { Set-EnvVar $envFile "ADMIN_ENABLED" "true" }
if (-not (Get-EnvVar $envFile "JIMBOMESH_HOLLER_NAME")) {
    Set-EnvVar $envFile "JIMBOMESH_HOLLER_NAME" $env:COMPUTERNAME
}

# Persist compose selection even when -NoStart is used.
if ($WithGpu) {
    Set-EnvVar $envFile "COMPOSE_FILE" "docker-compose.yml;docker-compose.gpu.yml"
} else {
    Set-EnvVar $envFile "COMPOSE_FILE" "docker-compose.yml"
}

# Mesh connectivity interactive prompt
Write-Host ""
Write-Host "  Connect to the JimboMesh mesh network?" -ForegroundColor White
Write-Host "  Share your GPU compute and earn Moonshine tokens." -ForegroundColor White
Write-Host "  You'll need an API key from app.jimbomesh.ai" -ForegroundColor Cyan
Write-Host ""
$meshChoice = Read-Host "  Connect to mesh? [y/N] (default: N)"
$WithMesh = $false
if ($meshChoice -match '^[Yy]') {
    Write-Host ""
    $meshUrl = Read-Host "  Mesh URL [https://api.jimbomesh.ai]"
    if ($meshUrl -eq '') { $meshUrl = 'https://api.jimbomesh.ai' }
    $meshKey = Read-Host "  API Key"
    if ($meshKey -ne '') {
        $defaultName = $env:COMPUTERNAME
        $hollerName = Read-Host "  Holler name (default: $defaultName)"
        if ([string]::IsNullOrWhiteSpace($hollerName)) { $hollerName = $defaultName }
        $WithMesh = $true
        Set-EnvVar $envFile "JIMBOMESH_API_KEY" $meshKey
        Set-EnvVar $envFile "JIMBOMESH_MESH_URL" $meshUrl
        Set-EnvVar $envFile "JIMBOMESH_HOLLER_NAME" $hollerName
        Set-EnvVar $envFile "JIMBOMESH_AUTO_CONNECT" "true"
        Write-Success "Mesh connectivity configured"
    } else {
        Set-EnvVar $envFile "JIMBOMESH_AUTO_CONNECT" "false"
        Write-Host "  No API key entered - mesh skipped" -ForegroundColor Yellow
    }
} else {
    Set-EnvVar $envFile "JIMBOMESH_AUTO_CONNECT" "false"
    Write-Host "  Mesh skipped (can configure later in Admin UI > Configuration)" -ForegroundColor Yellow
}

# Build image
# Ensure package-lock exists before Docker build (Dockerfile copies it explicitly)
if (-not (Test-Path (Join-Path $ScriptDir "package-lock.json"))) {
    Write-Warn "package-lock.json is missing. Regenerating before Docker build..."
    if (Test-Command npm) {
        Push-Location $ScriptDir
        & npm install --package-lock-only --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            Pop-Location
            Write-Err "Failed to regenerate package-lock.json with local npm."
            exit 1
        }
        Pop-Location
    } else {
        Write-Warn "npm not found locally. Using Docker fallback (node:22-alpine) to regenerate package-lock.json..."
        & docker run --rm -v "${ScriptDir}:/workspace" -w /workspace node:22-alpine sh -lc "npm install --package-lock-only --ignore-scripts --no-audit --no-fund"
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Failed to regenerate package-lock.json with Docker fallback."
            exit 1
        }
    }
    Write-Success "package-lock.json regenerated"
}

Write-Step "Building JimboMesh Holler Server image..."
Push-Location $ScriptDir
Invoke-Compose @("build", "jimbomesh-still")
Pop-Location
Write-Success "Image built successfully!"

if ($PullOnly) {
    Write-Host ""
    Write-Host "Done! Run the setup script again without -PullOnly to start services." -ForegroundColor Green
    exit 0
}

# Start services
if (-not $NoStart) {
    Write-Step "Starting services..."
    Push-Location $ScriptDir

    # COMPOSE_FILE is persisted earlier so choices survive even with -NoStart.
    if ($WithGpu) {
        Write-Host "  GPU passthrough enabled (written to .env)" -ForegroundColor Cyan
    }

    # Qdrant still uses compose profiles
    $upArgs = @("up", "-d")
    if ($WithQdrant) {
        $upArgs = @("--profile", "qdrant") + $upArgs
        Write-Host "  Local Qdrant enabled" -ForegroundColor Cyan
    }

    Invoke-Compose $upArgs
    Pop-Location

    # Wait for core container readiness (health if defined, else running)
    Write-Host "Waiting for core services to start" -NoNewline
    $ollamaReady = $false
    for ($i = 0; $i -lt 60; $i++) {
        $stillStatus = (docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" jimbomesh-still 2>$null | Select-Object -First 1).Trim()
        if ($stillStatus -in @("healthy", "running")) {
            $ollamaReady = $true
            Write-Host ""
            Write-Success "Core service is running!"
            break
        }
        Write-Host "." -NoNewline
        Start-Sleep -Seconds 2
    }

    if (-not $ollamaReady) {
        Write-Host ""
        Write-Warn "Ollama may still be pulling models. Check logs with: docker logs jimbomesh-still"
        Show-StartupDiagnostics -ServiceName "jimbomesh-still"
    }

    # Check Qdrant if enabled
    if ($WithQdrant) {
        Write-Host "Waiting for Qdrant to start" -NoNewline
        $qdrantReady = $false
        for ($i = 0; $i -lt 30; $i++) {
            $qdrantStatus = (docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" jimbomesh-holler-qdrant 2>$null | Select-Object -First 1).Trim()
            if ($qdrantStatus -in @("healthy", "running")) {
                $qdrantReady = $true
                Write-Host ""
                Write-Success "Qdrant is running!"
                break
            }
            Write-Host "." -NoNewline
            Start-Sleep -Seconds 1
        }
        if (-not $qdrantReady) {
            Write-Host ""
            Write-Warn "Qdrant may still be starting. Documents/RAG features may not be ready yet."
        }
    }
}

# Self-heal legacy stats schema after startup/reconfigure.
Repair-StatsSchema

# Read keys from .env
$connectKey = ""
$qdrantConnectKey = ""
if (Test-Path $envFile) {
    foreach ($line in (Get-Content $envFile)) {
        if ($line -match '^JIMBOMESH_HOLLER_API_KEY=(.+)$') {
            $connectKey = $Matches[1].Trim()
        }
        if ($line -match '^QDRANT_API_KEY=(.+)$') {
            $qdrantConnectKey = $Matches[1].Trim()
        }
    }
}

# Auto-launch Admin UI in browser
Write-Host ""
Write-Host "Opening Admin Dashboard..." -ForegroundColor Cyan
$launchPort = Get-EnvVar $envFile "GATEWAY_PORT"
if (-not $launchPort) { $launchPort = "1920" }
$adminUrl = "http://localhost:$launchPort/admin"
if ($connectKey) {
    $adminUrl = "http://localhost:$launchPort/admin#key=$connectKey"
}

# Quick readiness check (non-blocking)
$apiReady = $false
$apiHeaders = @{}
if ($connectKey) {
    $apiHeaders["X-API-Key"] = $connectKey
}
for ($i = 0; $i -lt 3; $i++) {
    try {
        $adminResp = Invoke-WebRequest -Uri "http://localhost:$launchPort/admin" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($adminResp.StatusCode -ge 200 -and $adminResp.StatusCode -lt 400) {
            $apiReady = $true
            break
        }
    } catch {
        # Fallback: API endpoint may still be auth-gated even when gateway is up.
        try {
            $resp = Invoke-WebRequest -Uri "http://localhost:$launchPort/api/tags" -UseBasicParsing -TimeoutSec 2 -Headers $apiHeaders -ErrorAction Stop
            if ($resp.StatusCode -in @(200, 401, 403)) {
                $apiReady = $true
                break
            }
        } catch {
            $statusCode = $null
            if ($_.Exception -and $_.Exception.Response -and $_.Exception.Response.StatusCode) {
                $statusCode = [int]$_.Exception.Response.StatusCode
            }
            if ($statusCode -in @(401, 403)) {
                $apiReady = $true
                break
            }
        }
    }
    if ($i -lt 2) { Start-Sleep -Seconds 1 }
}

try {
    Start-Process $adminUrl
    Write-Host "  Browser opened!" -ForegroundColor Green
    if (-not $apiReady) {
        Write-Host "  Holler may still be warming up. If page is blank, refresh in a few seconds." -ForegroundColor Yellow
    }
} catch {
    Write-Host "  Could not auto-open browser. Open manually:" -ForegroundColor Yellow
    Write-Host "  $adminUrl" -ForegroundColor White
}

# Keys already loaded from .env for launch and summary

# Persist performance mode choice and keep key ports synced.
Set-EnvVar $envFile "HOLLER_PERFORMANCE_MODE" "false"
if (-not (Get-EnvVar $envFile "GATEWAY_PORT")) {
    Set-EnvVar $envFile "GATEWAY_PORT" (Get-EnvVar $envFile "OLLAMA_HOST_PORT")
}
$gatewayHostPort = Get-EnvVar $envFile "GATEWAY_PORT"
if (-not $gatewayHostPort) { $gatewayHostPort = "1920" }

# Success
Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "                                                                " -ForegroundColor Green
Write-Host "         JimboMesh Holler Server installed successfully!         " -ForegroundColor Green
Write-Host "                                                                " -ForegroundColor Green
Write-Host "         Now go make some moonshine!                            " -ForegroundColor Green
Write-Host "                                                                " -ForegroundColor Green
if ($connectKey) {
    Write-Host "         Connect now from your browser at:                      " -ForegroundColor Green
    Write-Host "                                                                " -ForegroundColor Green
}

# Saved configuration summary from .env
$summaryServerName = Get-EnvVar $envFile "HOLLER_SERVER_NAME"
$summaryCompose = Get-EnvVar $envFile "COMPOSE_FILE"
$summaryGatewayPort = Get-EnvVar $envFile "GATEWAY_PORT"
$summaryOllamaPort = Get-EnvVar $envFile "OLLAMA_HOST_PORT"
$summaryModels = Get-EnvVar $envFile "HOLLER_MODELS"
$summaryMeshUrl = Get-EnvVar $envFile "JIMBOMESH_MESH_URL"
$summaryMeshKey = Get-EnvVar $envFile "JIMBOMESH_API_KEY"
$summaryAdminEnabled = Get-EnvVar $envFile "ADMIN_ENABLED"

if (-not $summaryServerName) { $summaryServerName = "Holler Server" }
if (-not $summaryCompose) { $summaryCompose = "docker-compose.yml" }
if (-not $summaryGatewayPort) { $summaryGatewayPort = "1920" }
if (-not $summaryOllamaPort) { $summaryOllamaPort = "1920" }
if (-not $summaryModels) { $summaryModels = "nomic-embed-text,llama3.1:8b" }
if (-not $summaryAdminEnabled) { $summaryAdminEnabled = "true" }

$summaryGpuMode = "CPU"
if ($summaryCompose -match 'docker-compose\.gpu\.yml') {
    $summaryGpuMode = "NVIDIA (docker-compose.gpu.yml)"
}
$summaryMesh = "Disconnected"
if ($summaryMeshKey) {
    if (-not $summaryMeshUrl) { $summaryMeshUrl = "https://api.jimbomesh.ai" }
    $summaryMesh = "Connected ($summaryMeshUrl)"
}
$summaryAdmin = if ($summaryAdminEnabled.ToLower() -eq "true") { "Enabled" } else { "Disabled" }

Write-Host ""
Write-Host "  +-----------------------------------------------------------+"
Write-Host "  |  Configuration saved to .env                             |"
Write-Host "  +-----------------------------------------------------------+"
Write-Host ("  |  Server Name:    {0,-41}|" -f $summaryServerName)
Write-Host ("  |  GPU Mode:       {0,-41}|" -f $summaryGpuMode)
Write-Host ("  |  Gateway Port:   {0,-41}|" -f $summaryGatewayPort)
Write-Host ("  |  Ollama Port:    {0,-41}|" -f $summaryOllamaPort)
Write-Host ("  |  Models:         {0,-41}|" -f $summaryModels)
Write-Host ("  |  Mesh:           {0,-41}|" -f $summaryMesh)
Write-Host ("  |  Admin:          {0,-41}|" -f $summaryAdmin)
Write-Host "  |                                                           |"
Write-Host "  |  All settings persist across reinstalls.                 |"
Write-Host "  |  Edit .env directly or use Admin UI to change settings.  |"
Write-Host "  +-----------------------------------------------------------+"
Write-Host "================================================================" -ForegroundColor Green

if ($connectKey) {
    Write-Host ""
    Write-Host "  http://localhost:$gatewayHostPort/admin#key=$connectKey" -ForegroundColor White
    Write-Host ""
    Write-Host "  (This URL auto-logs you in. Bookmark it or save the key.)" -ForegroundColor Yellow
    Write-Host "  [!!] The Admin URL contains your API key in the hash fragment." -ForegroundColor Yellow
    Write-Host "       It is NOT sent to any server - it stays in your browser only." -ForegroundColor Yellow
    Write-Host "       Do NOT share the full URL with the #key= part." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Quick reference:" -ForegroundColor White
Write-Host "  Admin UI:       http://localhost:$gatewayHostPort/admin" -ForegroundColor Cyan
Write-Host "  Ollama API:     http://localhost:$gatewayHostPort" -ForegroundColor Cyan
if ($WithQdrant) {
    Write-Host "  Qdrant REST:    http://localhost:6333" -ForegroundColor Cyan
    Write-Host "  Qdrant gRPC:    localhost:6334" -ForegroundColor Cyan
}
Write-Host "  API Key:        $(Mask-Key $connectKey)" -ForegroundColor Cyan
if ($qdrantConnectKey) {
    Write-Host "  Qdrant Key:     $(Mask-Key $qdrantConnectKey)" -ForegroundColor Cyan
}
Write-Host "  Config:         $ScriptDir\.env" -ForegroundColor Cyan

Write-Host ""
Write-Host "Useful commands:" -ForegroundColor White
Write-Host "  View logs:      docker logs -f jimbomesh-still" -ForegroundColor Cyan
Write-Host "  List models:    curl -H 'X-API-Key: YOUR_KEY' http://localhost:$gatewayHostPort/api/tags" -ForegroundColor Cyan
Write-Host "  Pull model:     docker exec jimbomesh-still ollama pull <model>" -ForegroundColor Cyan
Write-Host "  Stop:           cd $ScriptDir && $ComposeCmd down" -ForegroundColor Cyan
Write-Host "  Start:          cd $ScriptDir && $ComposeCmd up -d" -ForegroundColor Cyan
Write-Host "  Restart:        cd $ScriptDir && $ComposeCmd restart jimbomesh-still" -ForegroundColor Cyan

Write-Host ""
Write-Host "Test embedding:" -ForegroundColor White
Write-Host "  curl http://localhost:$gatewayHostPort/api/embed -d '{""model"":""nomic-embed-text"",""input"":""hello world""}'" -ForegroundColor Cyan

Write-Host ""
Write-Host "Documentation:    $ScriptDir\docs\" -ForegroundColor White
Write-Host "GitHub:           https://github.com/IngressTechnology/jimbomesh-holler-server" -ForegroundColor White

Write-Host ""
Write-Host "Ollama is ready. Embeddings are local." -ForegroundColor Yellow
Write-Host ""
