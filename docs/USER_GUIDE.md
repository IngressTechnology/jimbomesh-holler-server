# JimboMesh Holler User Guide

Welcome to JimboMesh Holler, your own local AI compute node. It lets you run models on your own hardware, keep prompts and responses close to home, and optionally connect to the JimboMesh mesh when you want to share compute.

If you want the fastest install path, start with [Quick Start](../QUICK_START.md). If you want API examples or IDE setup details, the best follow-up docs are [API Usage](API_USAGE.md) and [IDE Integrations](IDE_INTEGRATIONS.md).

## Three Ways To Run Holler

### Option 1: Desktop App

This is the easiest path for most people.

1. Download the installer for your platform from [GitHub Releases](https://github.com/IngressTechnology/jimbomesh-holler-server/releases)
2. Run the installer
3. Launch JimboMesh Holler
4. Let first-run setup finish if you choose standalone mode
5. The app opens your local admin dashboard automatically

Typical release files:

- Windows: `.exe`
- macOS: `.dmg`
- Linux: `.AppImage`

The desktop app can work in two modes:

- Attach mode: use an existing Holler already running on port `1920`
- Standalone mode: the app manages a local Holler for you

### Option 2: Docker

If you are comfortable with Docker and want a clean local service:

```bash
docker run -d --name holler \
  -p 1920:1920 \
  -p 9090:9090 \
  -e JIMBOMESH_HOLLER_API_KEY=$(openssl rand -hex 32) \
  ghcr.io/ingresstechnology/jimbomesh-holler-server:latest
```

Then open:

- Admin UI: `http://localhost:1920/admin`
- API root: `http://localhost:1920/v1`

### Option 3: From Source

This is best if you want to tinker or contribute.

```bash
git clone https://github.com/IngressTechnology/jimbomesh-holler-server.git
cd jimbomesh-holler-server
cp .env.example .env
npm install
node api-gateway.js
```

## Port 1920

Holler uses port `1920` by default, the year Prohibition started. That moonshine reference is part of the project's identity, so if you see `1920` everywhere, that is on purpose.

## First Stop: The Admin Dashboard

Open `http://localhost:1920/admin` in your browser, or just use the desktop window if you installed the app.

The admin UI uses a top tab bar, not a sidebar. Depending on your version and features enabled, you will see tabs such as:

- `Dashboard`
- `Models`
- `Mesh`
- `Playground`
- `Statistics`
- `Configuration`
- `System`
- `Activity`
- `Documents`
- `Feedback`

If the installer or desktop app gives you an auto-login URL with `#key=...`, that is normal. The hash fragment helps you sign in quickly and is stripped from the URL after login.

## What Each Tab Does

### Dashboard

This is the home screen for your Holler.

You can check:

- Server health and uptime
- Installed and running model counts
- Basic performance and status info
- Whether everything looks alive without opening logs

### Models

This is where you manage the brains.

You can:

- See which models are already installed
- Pull new models from the marketplace
- Remove models you no longer want
- Check GPU fit hints and VRAM guidance when supported

Good first models:

- `llama3.2:1b` for a tiny, friendly starter model
- `llama3.2:1b` as the default all-round local chat model that fits most hardware
- `nomic-embed-text` for embeddings and document search

### Playground

This is where you talk to your models and make sure everything is working.

You can use it to:

- Chat with local models
- Test prompts before wiring Holler into other tools
- Try embeddings and generation features without writing code

Everything here runs locally unless you intentionally connect to outside services.

### Statistics

This tab helps answer, "What has this machine actually been doing?"

You will usually find:

- Request counts
- Latency trends
- Error totals
- Model usage and cost or savings style metrics

### Configuration

This is the control room.

You can manage:

- Server name
- Runtime settings and limits
- API keys
- Security options
- Restart actions

If you only remember one secret, remember this one:

- `JIMBOMESH_HOLLER_API_KEY` protects your local Holler

Do not post that key publicly.

### Mesh

This is where you connect your Holler to the JimboMesh marketplace.

You can:

- Connect, disconnect, cancel, reconnect, or forget a stored mesh key
- Set coordinator URL, Holler name, and auto-connect behavior
- Watch live connection state and status changes
- Track mesh stats, job activity, and connection logs

### System

This tab is the machine-room view.

It helps with:

- Port and binding checks
- Storage and volume visibility
- Environment and runtime clues when something feels off

### Activity

This is your recent request log.

It is handy when you want to know:

- What requests came in
- Which endpoint was called
- How long it took
- Whether something failed

### Documents

If you enable document search and Qdrant, this tab lets you build a local RAG setup.

You can:

- Upload supported files like `.pdf`, `.md`, `.txt`, `.csv`, and `.docx`
- Chunk and embed those files locally
- Search across them semantically
- Ask questions against your document set

### Feedback

If GitHub integration is configured, this tab can send bug reports or feature requests straight to the repository.

## Using Holler With IDEs And Apps

Holler exposes an OpenAI-compatible API, which means lots of tools can talk to it without special glue.

Use:

- Base URL: `http://localhost:1920/v1`
- Chat endpoint: `http://localhost:1920/v1/chat/completions`
- Embeddings endpoint: `http://localhost:1920/v1/embeddings`
- API key: your `JIMBOMESH_HOLLER_API_KEY`

That works with tools like Cursor, Continue, JetBrains plugins, Aider, and other OpenAI-compatible clients. The full setup walkthroughs live in [IDE Integrations](IDE_INTEGRATIONS.md).

## Connecting To The Mesh

You can run Holler completely standalone, and plenty of people will. If you want to share compute and use the wider JimboMesh network, connect it to the mesh.

### What The Mesh Is

The mesh is a network of Hollers that can share AI compute.

Simple version:

- Share your idle hardware and earn Moonshine
- Use other Hollers when you need more horsepower
- Keep the actual inference runtime on the Holler side

### How To Connect

1. Create an account at [app.jimbomesh.ai](https://app.jimbomesh.ai)
2. Generate a mesh API key that starts with `jmsh_`
3. Add it to your `.env` as `JIMBOMESH_API_KEY=jmsh_your_key_here`
4. Restart Holler, or reconnect from the admin UI if your setup supports it
5. Check the mesh-related status in the admin UI

You may also see settings for:

- `JIMBOMESH_COORDINATOR_URL`
- `JIMBOMESH_HOLLER_NAME`
- `JIMBOMESH_AUTO_CONNECT`

### Privacy Promise

The important hard rule is simple:

The SaaS coordination layer stores nothing from inference. No prompts. No responses. No chat history. Holler is the thick runtime. The SaaS side is thin coordination.

### Kinfolk Groups

Kinfolk groups are the private-sharing version of the mesh idea. They are meant for sharing with friends, family, or trusted people rather than the wider network.

### Moonshine

Moonshine is the mesh economy token.

- Earn it by sharing compute
- Spend it when you use remote compute
- Track usage and savings from the dashboard and related stats views

## Privacy And Security

Holler is built around local control.

- Your local prompts and responses stay on your machine unless you deliberately use a remote service
- Even in mesh mode, the coordination service is not supposed to store inference content
- Your local API key protects access to your Holler
- Mesh connections are outbound, which is much friendlier to home networks, NAT, and firewalls

If you are running Holler on a machine other people can reach over the network, lock down access and keep your API keys private.

## Troubleshooting

### Holler Will Not Start

Check whether port `1920` is already busy.

On Windows:

```powershell
netstat -ano | findstr 1920
```

On macOS or Linux:

```bash
lsof -i :1920
```

Also check:

- Docker container logs if you are using Docker
- Whether Ollama is installed and available if you are using the desktop app in standalone mode
- Whether `.env` contains a valid `JIMBOMESH_HOLLER_API_KEY`

### Models Will Not Download

Things to check:

- Internet connection
- Free disk space, because models can get big fast
- Ollama health if you are in a local or standalone setup
- The `Models` tab for progress or error messages

### Mesh Will Not Connect

Check the basics first:

- Your mesh key starts with `jmsh_`
- `JIMBOMESH_API_KEY` is set correctly
- Outbound HTTPS is allowed from your machine
- The JimboMesh service is healthy

Useful links:

- [app.jimbomesh.ai](https://app.jimbomesh.ai)
- [status.jimbomesh.ai](https://status.jimbomesh.ai)

### GPU Not Showing Up

- NVIDIA: make sure drivers are installed and `nvidia-smi` works
- Apple Silicon: Metal acceleration depends on the supported setup path
- No GPU is still okay; Holler can run on CPU, just slower

## System Requirements

These are practical starting points, not hard walls.

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| RAM | 8 GB | 16 GB or more |
| Storage | 10 GB free | 50 GB or more for multiple models |
| GPU | Optional | NVIDIA GPU with 8+ GB VRAM or Apple Silicon |
| OS | Windows 10+, macOS 12+, modern Linux | Current stable release |
| Network | Optional for standalone | Broadband helps with model downloads and mesh use |

## Where To Go Next

- Use [Quick Start](../QUICK_START.md) if you want the shortest install path
- Use [API Usage](API_USAGE.md) if you want curl and Postman examples
- Use [IDE Integrations](IDE_INTEGRATIONS.md) if you want to hook Holler into your editor
- Use [Troubleshooting](TROUBLESHOOTING.md) if something feels busted
