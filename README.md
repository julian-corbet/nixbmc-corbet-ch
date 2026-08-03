# nixbmc

Two things a baseboard management controller needs, kept in one repo because
they are both "BMC-shaped" and nothing else:

- **Local BMC access, as a NixOS module** (`nixbmc.*`, `modules/default.nix`) — real,
  implemented, checked. ipmitool (plus the in-band IPMI kernel interface it needs) and/or
  flashrom, installed declaratively. In-band (KCS/SSIF) only: no BMC IP, no credentials,
  nothing to unseal.
- **A clean-room, browser-native replacement for the flaky bundled KVM viewer** on
  AMI MegaRAC-family BMCs (AST2500/AST2600, the same firmware lineage shipped by Gigabyte,
  Supermicro, ASRock Rack, Tyan, and Lenovo) — still pre-alpha, blocked on the open questions
  below.

## Local BMC access (`nixbmc.*`)

The LOCAL leg only — the in-band KCS/SSIF interface every BMC of this class exposes to its
own host, with no network hop, no BMC IP, and no credentials to manage. A REMOTE leg
(Redfish/HTTPS, with BMC credentials from wherever a consumer keeps secrets) is a genuinely
different concern — different transport, different auth, different failure mode — and this
module does not attempt it.

```nix
# flake.nix (consumer side)
{
  inputs.nixbmc.url = "github:julian-corbet/nixbmc-corbet-ch";

  outputs = { self, nixpkgs, nixbmc, ... }: {
    nixosConfigurations.example-host = nixpkgs.lib.nixosSystem {
      modules = [ nixbmc.nixosModules.default ./configuration.nix ];
    };
  };
}
```

```nix
# configuration.nix
nixbmc.enable = true;
nixbmc.ipmitool.enable = true; # ipmitool + ipmi_devintf/ipmi_si, e.g. `ipmitool dcmi power reading`
nixbmc.flashrom.enable = true; # SPI NOR read/write via an external clip programmer (recovery lever)
```

Options reference (`modules/default.nix`):

- `nixbmc.enable` — the top-level gate. Nothing below is installed or loaded unless this is
  true, even if a sub-tool's own `.enable` is set (proven both ways in `checks/default.nix`).
- `nixbmc.ipmitool.enable` — installs `ipmitool` and explicitly loads `ipmi_devintf` +
  `ipmi_si`, the two kernel modules `/dev/ipmi0` depends on. Declared explicitly rather than
  left to autoload: without them ipmitool fails with a "Could not open device" error that
  reads like a permissions problem, not a missing module.
- `nixbmc.flashrom.enable` — installs `flashrom` for reading/writing SPI NOR flash chips with
  an external programmer (e.g. CH341A + SOIC-8 clip). Deliberately does not vouch for
  `-p internal` self-flashing on any given chipset — see the option's own description for
  why. The clip path is what makes this module worth having at all: it bypasses the BMC chip
  and host chipset entirely, so the same tool and physical clip recover BOTH a bricked host
  BIOS chip and a bricked BMC flash chip.

Why one option per tool rather than a single `nixbmc.enable`: a host that only wants a power
reading (`ipmitool dcmi power reading`) should not silently acquire a firmware-flashing
utility as a side effect of asking for one, and vice versa.

Why this is not folded into a power-stance module (e.g.
[nixpower](https://github.com/julian-corbet/nixpower-corbet-ch), which names this module by
reference for exactly this reason): a BMC is a whole second computer inside the box, with its
own firmware and its own view of the hardware. It *answers* power questions but it is not a
power knob, and folding its tooling into a power-stance module makes both harder to reason
about.

## The browser KVM viewer (planned)

[`rd450x-console`](https://github.com/BadCoder1337/rd450x-console) is the
precedent this project follows the shape of, not the substance: it replaces a
Lenovo RD450X's `JViewer.jar` — a Java Web Start applet from before browsers
dropped plugin support — with a native Go binary that bridges to noVNC. Go was
the only option there, because there was no way to speak that protocol from a
browser at all.

That constraint doesn't apply to us. Our BMC's own KVM client (H5Viewer) is
already HTML5/JS/WebSocket — no plugin, no native binary, nothing to bridge.
The problem was never "no browser-native client exists," it's "the one that
ships is flaky." Reimplementing the whole protocol in a compiled language just
to hand the result back to a browser via noVNC would be solving a problem we
don't have while adding a server process we don't need.

nixbmc is instead a **clean-room JavaScript client** (same clean-room posture
as `rd450x-console` — reverse-engineered protocol facts reimplemented fresh,
never the vendor's own extracted JS committed here) that talks directly to the
BMC's real REST + WebSocket surface (`POST /api/session`, `wss://<bmc>/kvm`,
the IVTP framing, the ASPEED VQ+JPEG+RC4 codec — all documented from a live
capture against a real board), running entirely in the browser. The one
supporting piece is a small reverse proxy in front of the BMC, needed for two
reasons that have nothing to do with the protocol itself:

- **TLS trust.** The BMC presents a self-signed cert; a browser will not let
  a `wss://` connection through an untrusted cert the way it lets you click
  past a warning on a normal page load. The proxy terminates a real cert on
  our side and skips verification on its own leg to the BMC (same posture
  `rd450x-console` takes).
- **Auth brokering.** The proxy — not the browser — holds the BMC's admin
  credential (sops) and performs `POST /api/session` itself, so the real BMC
  password never reaches client-side JS. The browser only needs to reach our
  service.

Everything protocol-level (session-token handshake, IVTP opcodes, video
decode, HID input) is a static page's job. The proxy is dumb plumbing, not a
protocol reimplementation.

## Status

**`nixbmc.*` (local access) is real and checked in** — `modules/default.nix`, proven both
directions (enabled produces exactly the expected packages + kernel modules; disabled
produces nothing) in `checks/default.nix`, run under `nix flake check`.

- [x] `nixosModules.nixbmc` / `.default` (`modules/default.nix`)
- [x] `nixbmc.enable` / `.ipmitool.enable` / `.flashrom.enable`
- [x] eval-time proof of the option surface, both directions (`checks/default.nix`)
- [ ] Redfish/remote-BMC leg (out of scope for this module; a genuinely separate concern —
  see "Local BMC access" above)

**The browser KVM viewer is pre-alpha — scaffold only, no module written yet.** Blocked on two
open questions before the first line of the actual client/proxy gets written
(bringing these here rather than guessing, per the project's own "no MVP,
build the right end state" habit — guessing wrong on either one means
reworking the module's shape, not just a config tweak):

1. **Where does the proxy run?** The whole point of the AST2500 KVM leg (in
   the wider bare-metal command-central plan this project split off from)
   is pre-boot / degraded-state access — reachable when the pools are down or
   k3s itself isn't up. Running nixbmc *as a k3s app* would make it share fate
   with exactly the failure modes it's meant to survive. Leaning towards: a
   small bare-metal NixOS-declared systemd service on the hub host itself
   (same posture as `rescue-maintain` / other bare-metal-declared services),
   not a k3s deployment.
2. **Exposure model.** NetBird-only (matches how sensitive out-of-band access
   is generally treated — full HID/keyboard/mouse control of the physical
   host is a bigger blast radius than most services across hosts), or also reachable
   via cloudflared for access from a device with no NetBird client installed?
   The "go to a URL on my phone" framing from the wider vision could mean
   either, depending on whether the phone is expected to already be on the
   NetBird mesh.

Once those land, scope for the first real version: full view **and** input
(keyboard/mouse HID) against our specific board first, written generically
enough (BMC host/credentials as NixOS module options, not hardcoded) that any
AMI MegaRAC-family BMC of this firmware generation is a config change away —
matching how the credentials/target stay private (this repo's own values)
while the mechanism stays public, the same split every other project in this
family uses. Virtual media (remote ISO mounting) is explicitly out of scope
for v1 — display + input is the actual ask.

## Repository layout

| Path | Purpose |
|---|---|
| `flake.nix` | `nixosModules.nixbmc`/`.default` (local access, real); `checks`. `nixosModules.kvm` lands once the open questions above are resolved. |
| `modules/default.nix` | `nixbmc.*` option schema + systemd/kernel wiring for local BMC access — ipmitool and flashrom. |
| `checks/default.nix` | Eval-time proof of the `nixbmc.*` option surface, both directions. |
| `experiments/` | Throwaway trials — see [`experiments/README.md`](experiments/README.md). |
| `studies/` | Written-up findings — see [`studies/README.md`](studies/README.md). |

## Related projects

nixbmc is one of several small, independently-usable open-source projects
sharing a common design system: [nixarch](https://github.com/julian-corbet/nixarch-corbet-ch),
nixvps, nixram, nixnas, [nixremote](https://github.com/julian-corbet/nixremote-corbet-ch),
[nixsh](https://github.com/julian-corbet/nixsh-corbet-ch), and
[nixpower](https://github.com/julian-corbet/nixpower-corbet-ch) (the power-stance mechanism
`nixbmc.*` deliberately stays out of — see "Local BMC access" above; nixpower's own module
names this repo by reference for anything BMC-shaped). Its niche is a BMC's own surfaces —
local in-band access today, an out-of-band console protocol once the KVM viewer lands —
narrow by design, useful to anyone with the same class of hardware regardless of whether they
run anything else in this family.

## License

[MIT License](LICENSE) © 2026 Julian Corbet
