# 🥃 Jimbo's Field Guide to Runnin' a Holler

*Official JimboMesh Documentation — Written by Jimbo himself, from his cabin in the holler.*

---

## Welcome to the Mesh, Partner

If you're readin' this, congratulations — you've done gone and set yourself up a genuine, bonafide JimboMesh Holler. That means you're now part of the most decentralized, moonshine-powered AI network this side of the Appalachian Trail.

This here document is your starter kit. Drop it into your **Documents** tab and let your Holler chew on it. Ask questions. Get answers. That's the whole point.

---

## What in Tarnation is a Holler?

A **Holler** is your own personal AI still. It sits on your hardware, runs your models, and keeps your data where it belongs — *on your land*. No cloud. No corporate overlords. No data leavin' your property line.

Think of it like a moonshine still, but instead of corn liquor, you're brewin' up **Moonshine** — that's what we call AI tokens 'round here.

| Term | What It Means |
|------|---------------|
| **Holler** | Your Docker container runnin' JimboMesh |
| **Moonshine** | AI tokens (the good stuff) |
| **Still** | The JimboMesh service itself |
| **Mesh** | The network of Hollers workin' together |
| **Jimbo** | That'd be me. The founder. The legend. |

---

## Jimbo's Contact Book

These are the fine folks you might run into on the Mesh:

### 🤠 Jimbo "The Founder" McGraw
- **Role:** Chief Moonshiner & Mesh Architect
- **Location:** Somewhere in the holler, exact coordinates classified
- **Specialty:** Model tuning, hardware wranglin', and questionable life decisions
- **Favorite Model:** Llama 3.2 — "She runs smooth as Sunday mornin'"
- **Contact:** Don't call me, I'll call you

### 🔧 Dolly Parton-8B
- **Role:** Head of Holler Operations
- **Location:** GPU Farm #7, behind the barn
- **Specialty:** Embeddings, vector search, and singin' while she works
- **Fun Fact:** Can chunk a 500-page PDF faster than Jimbo can open a jar of pickles
- **Status:** Always workin' 9 to 5

### 🐕 Hound Dog
- **Role:** Security & Watchdog Services
- **Location:** Patrols the perimeter of every Holler
- **Specialty:** Sniffin' out unauthorized API requests
- **Alert Style:** Barks once for 401, twice for 403, howls for 500
- **Weakness:** Treats (and SQL injection, but we fixed that)

### 🏗️ Big Earl
- **Role:** Infrastructure & Hardware
- **Location:** The server room (a.k.a. the shed)
- **Specialty:** Keepin' the GPUs cool and the power bill reasonable
- **Philosophy:** "If it ain't broke, don't update it. If it IS broke, have you tried turnin' it off and on again?"
- **VRAM Policy:** "8 gigs is plenty if you ain't greedy"

### 📊 Miss Daisy Mae
- **Role:** Analytics & Reporting
- **Location:** The front porch, watchin' the metrics roll by
- **Specialty:** Token counting, usage dashboards, and judgin' your prompt engineering
- **Catchphrase:** "Boy, that prompt was rougher than a cob. Let me show you how it's done."

---

## Holler Hardware Requirements

Jimbo's official recommendations for runnin' a proper Holler:

### The Bare Minimum (The "Budget Still")
- **CPU:** Anything made this decade
- **RAM:** 16 GB (32 if you're feelin' fancy)
- **GPU:** None required, but you'll be waitin' longer than a possum playin' dead
- **Storage:** 20 GB free (models are chunky, like Jimbo's cousin Earl)

### The Sweet Spot (The "Saturday Night Special")
- **CPU:** 8+ cores
- **RAM:** 32 GB
- **GPU:** NVIDIA with 8 GB VRAM (RTX 3060/4060 or better)
- **Storage:** 100 GB SSD
- **Jimbo's Take:** "Now we're cookin' with gas"

### The Full Holler (The "Copper Pot Deluxe")
- **CPU:** 16+ cores
- **RAM:** 64+ GB
- **GPU:** NVIDIA with 16+ GB VRAM (RTX 4080/4090, A4000, etc.)
- **Storage:** 500 GB NVMe
- **Jimbo's Take:** "Son, that's more power than my truck. I love it."

---

## Jimbo's Moonshine Recipes (Model Recommendations)

| Model | Size | VRAM Needed | Jimbo's Rating | Best For |
|-------|------|-------------|----------------|----------|
| Llama 3.2 1B | 1.3 GB | 4 GB | ⭐⭐⭐ "Quick sip" | Fast answers, simple tasks |
| Llama 3.2 3B | 2.0 GB | 4 GB | ⭐⭐⭐⭐ "Smooth" | General purpose, good balance |
| Phi-4 Mini | 2.4 GB | 4 GB | ⭐⭐⭐⭐ "Sneaky strong" | Reasoning, math, code |
| Mistral 7B | 4.1 GB | 6 GB | ⭐⭐⭐⭐ "Old reliable" | All-rounder |
| Llama 3.1 8B | 4.7 GB | 8 GB | ⭐⭐⭐⭐⭐ "Top shelf" | Best quality per VRAM dollar |
| Gemma 2 9B | 5.5 GB | 8 GB | ⭐⭐⭐⭐⭐ "Google's finest" | Code, analysis, writing |
| DeepSeek-R1 8B | 4.9 GB | 8 GB | ⭐⭐⭐⭐ "The thinker" | Step-by-step reasoning |
| nomic-embed-text | 274 MB | 2 GB | 🔧 "Essential" | Document embeddings (RAG) |

> **Jimbo's Pro Tip:** "Start with Llama 3.2 3B. She's light, she's fast, and she won't hog all your VRAM like my cousin at a buffet. Scale up when you need to."

---

## Frequently Asked Questions (Jimbo's FAQ)

**Q: Is my data sent to the cloud?**
A: Absolutely not. Your data stays in your Holler like a hermit stays in his cabin. We don't want your data. We got our own problems.

**Q: Can I run multiple models?**
A: Sure can! Ollama handles model swappin' like Jimbo handles gear changes in his old pickup — a little rough but it gets there.

**Q: What's the Mesh for?**
A: The Mesh connects Hollers together so they can share compute. You sell your spare Moonshine, other folks buy it. Everybody wins. It's like a co-op, but for AI.

**Q: Do I need the Mesh?**
A: Nope. Your Holler works just fine standalone. The Mesh is optional — like pants on a Saturday.

**Q: Why is it called Moonshine?**
A: Because, like real moonshine, it's locally produced, ain't regulated by Big Tech, and a little bit goes a long way. Also, Jimbo thought it was funny.

**Q: My GPU sounds like a jet engine. Is that normal?**
A: That's just the sound of progress, friend. Make sure your fans ain't blocked. Big Earl recommends pointin' a box fan at your rig if you're runnin' a 7B+ model in the summer.

**Q: Can I fine-tune models on my Holler?**
A: That's on the roadmap, partner. For now, stick with the pre-trained models. Jimbo's workin' on it between fishing trips.

---

## Jimbo's Rules of the Holler

1. **Your data, your land.** What happens in the Holler stays in the Holler.
2. **Don't be greedy with VRAM.** Run the model that fits, not the model that impresses.
3. **Back up your documents.** Jimbo learned this the hard way when his dog ate his USB drive.
4. **Share the Moonshine.** If you got spare compute, put it on the Mesh. Good karma.
5. **Read the docs.** You're doin' it right now. Jimbo's proud of you.

---

## About JimboMesh

JimboMesh is an open source decentralized AI compute marketplace built by **Ingress Technology**.

- 🌐 **Website:** [jimbomesh.ai](https://jimbomesh.ai)
- 🏢 **Built by:** [Ingress Technology](https://ingresstechnology.ai) — Fractional CTO Services for Furniture Manufactures and Retailers
- 📦 **GitHub:** [github.com/IngressTechnology](https://github.com/IngressTechnology)
- 🥃 **Philosophy:** AI should be local, private, and accessible to everyone — not just Big Tech.

---

*"If you can run Docker, you can run a Holler. And if you can run a Holler, well partner, you're in the AI business."*
— Jimbo McGraw, Founder

---

*© 2026 Ingress Technology LLC. Made with ❤️ and a healthy disrespect for cloud vendor lock-in.*
