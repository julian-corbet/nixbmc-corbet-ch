# nixbmc

Two things a baseboard management controller needs, kept in one repo because
they are both "BMC-shaped" and nothing else:

- **BMC access, as a NixOS or Arch/system-manager module** (`nixbmc.*`, `modules/`) — real,
  implemented, checked. ipmitool (plus, on NixOS with `ipmitool.inBand` at its default `true`,
  the in-band IPMI kernel interface it needs) and/or flashrom, installed declaratively. Still
  no BMC IP, no credentials, nothing to unseal on either backend or either `inBand` setting —
  see below.
- **A clean-room, browser-native replacement for the flaky bundled KVM viewer** on
  AMI MegaRAC-family BMCs (AST2500/AST2600, the same firmware lineage shipped by Gigabyte,
  Supermicro, ASRock Rack, Tyan, and Lenovo) — pre-alpha. The codec is written and partly
  working; the session, transport, render and input layers are not. The open questions below
  gate the proxy and its module, not the codec.

## BMC access (`nixbmc.*`)

Still no BMC IP, no credentials, nothing to unseal, on EITHER backend or EITHER `ipmitool.inBand`
setting. `ipmitool.inBand` only changes which INTERFACE ipmitool expects: the in-band KCS/SSIF
`/dev/ipmi0` device every BMC of this class exposes to its own host (`true`, the default — no
network hop), or nothing local at all, for a host that is purely an out-of-band client of a
*different* machine's BMC over the LAN (`false` — `ipmitool -I lanplus -H <bmc-ip> -U ... -P ...`,
with the operator supplying those flags themselves; this module never touches them). A REMOTE leg
in the Redfish/HTTPS sense — BMC credentials sourced from wherever a consumer keeps secrets — is a
genuinely different concern regardless of `inBand`, and this module does not attempt it.

```nix
# flake.nix (consumer side)
{
  inputs.nixbmc.url = "github:julian-corbet/nixbmc-corbet-ch";

  outputs = { self, nixpkgs, nixbmc, ... }: {
    # A host with its own local BMC:
    nixosConfigurations.example-host = nixpkgs.lib.nixosSystem {
      modules = [ nixbmc.nixosModules.default ./configuration.nix ];
    };
  };
}
```

```nix
# configuration.nix (NixOS, local BMC)
nixbmc.enable = true;
nixbmc.ipmitool.enable = true; # ipmitool + ipmi_devintf/ipmi_si (inBand defaults to true), e.g. `ipmitool dcmi power reading`
nixbmc.flashrom.enable = true; # SPI NOR read/write via an external clip programmer (recovery lever)
```

A host with no BMC of its own that only ever reaches someone else's, over the network, is an
out-of-band CLIENT: it wants the `ipmitool` binary and nothing kernel-shaped. On NixOS that's
`nixbmc.ipmitool.inBand = false`; on Arch/system-manager, `inBand` defaults to `true` but the
plane has no `boot.kernelModules` to honour it with, so leaving it at the default is an eval-time
assertion, not a silent no-op — `inBand = false` is required there:

```nix
# configuration.nix (either backend, out-of-band client only)
nixbmc.enable = true;
nixbmc.ipmitool.enable = true;
nixbmc.ipmitool.inBand = false; # this box has no local BMC; reaches another machine's over the LAN
```

```nix
# flake.nix (consumer side, Arch/system-manager)
systemConfigs.example-laptop = system-manager.lib.makeSystemConfig {
  modules = [ nixbmc.systemManagerModules.default ./configuration.nix ];
};
```

Options reference (`modules/nixbmc.nix`, resolved per-platform by `modules/nixos.nix` /
`modules/arch.nix`):

- `nixbmc.enable` — the top-level gate. Nothing below is installed or loaded unless this is
  true, even if a sub-tool's own `.enable` is set (proven both ways in `checks/default.nix`).
- `nixbmc.ipmitool.enable` — installs `ipmitool`. Which interface it talks over is
  `ipmitool.inBand`, below.
- `nixbmc.ipmitool.inBand` — `true` (default, byte-identical to this module's original
  single-host behaviour) additionally loads `ipmi_devintf` + `ipmi_si`, the two kernel modules
  `/dev/ipmi0` depends on, on the NixOS backend — declared explicitly rather than left to
  autoload, since without them ipmitool fails with a "Could not open device" error that reads
  like a permissions problem, not a missing module. `false` installs the binary only, for a
  host with no local BMC that reaches a different machine's over the LAN. The Arch/
  system-manager backend has no `boot.kernelModules` at all, so it refuses `true` with an
  eval-time assertion rather than pretending to honour it.
- `nixbmc.flashrom.enable` — installs `flashrom` for reading/writing SPI NOR flash chips with
  an external programmer (e.g. CH341A + SOIC-8 clip). Deliberately does not vouch for
  `-p internal` self-flashing on any given chipset — see the option's own description for
  why. The clip path is what makes this module worth having at all: it bypasses the BMC chip
  and host chipset entirely, so the same tool and physical clip recover BOTH a bricked host
  BIOS chip and a bricked BMC flash chip.
- `nixbmc.archPackages` / `nixbmc.aurPackages` — read-only; the enabled tools as pacman package
  names, for a consumer's own Arch reconciler (e.g. `nixarch.packages.pacman =
  config.nixbmc.archPackages;`). `aurPackages` is always empty today — kept only for
  shape-consistency with nixdev/nixoffice, the rest of this design-system family.

Why one option per tool rather than a single `nixbmc.enable`: a host that only wants a power
reading (`ipmitool dcmi power reading`) should not silently acquire a firmware-flashing
utility as a side effect of asking for one, and vice versa.

Why this is not folded into a power-stance module (e.g.
[nixpower](https://github.com/julian-corbet/nixpower-corbet-ch), which names this module by
reference for exactly this reason): a BMC is a whole second computer inside the box, with its
own firmware and its own view of the hardware. It *answers* power questions but it is not a
power knob, and folding its tooling into a power-stance module makes both harder to reason
about.

## The browser KVM viewer (pre-alpha)

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

**`nixbmc.*` (BMC access) is real and checked in** — three files (`modules/nixbmc.nix` the
option surface, `modules/nixos.nix` and `modules/arch.nix` the two backends), proven both
directions on both backends (enabled produces exactly the expected packages + kernel modules
or archPackages entries; disabled produces nothing; a shape the current backend cannot satisfy
raises an eval-time assertion rather than silently doing nothing) in `checks/default.nix`, run
under `nix flake check`.

- [x] `nixosModules.nixbmc` (`modules/nixbmc.nix`) / `.default` (`modules/nixos.nix`)
- [x] `systemManagerModules.nixbmc` / `.default` (`modules/arch.nix`)
- [x] `nixbmc.enable` / `.ipmitool.enable` / `.ipmitool.inBand` / `.flashrom.enable`
- [x] `nixbmc.archPackages` / `.aurPackages`, for the Arch backend's consumer to feed its own
  reconciler
- [x] eval-time proof of the option surface, both directions, both backends
  (`checks/default.nix`)
- [ ] Redfish/remote-BMC leg (out of scope for this module; a genuinely separate concern —
  see "BMC access" above)

**The browser KVM viewer is pre-alpha.** The codec is written — `client/codec/`, a clean-room
port of the ASPEED VQ + JPEG + RC4 + YUV path — and its JPEG path decodes a real frame. No other
layer of the client exists.

| Layer | State |
|---|---|
| Codec (`client/codec/`, 10 files) | Written; JPEG path decodes. See the defects below |
| IVTP framing / WebSocket transport | Not written |
| `POST /api/session` handshake | Not written |
| Canvas render loop | Not written |
| HID keyboard/mouse input | Not written |
| Reverse proxy (TLS termination + auth brokering) | Not written — gated on the open questions |
| `nixosModules.kvm` | Not written — gated on the open questions |

Known defects in the codec. **None of these are gated on the open questions** — the codec is pure
client-side and can be fixed and tested without settling where anything runs:

- **VQ writes the 4:4:4 tile layout while decoding 4:2:0.** `client/codec/vq.js` fills
  `st.yuvTile` at offsets 0/64/128 for 64 pixels, which is the 4:4:4 shape. The 4:2:0 path in
  `client/codec/yuv.js` reads four luma blocks at 0–255, Cb at 256–319 and Cr at 320–383 — so
  luma blocks 1 and 2 receive the Cb and Cr values *as luma*, while luma block 3 and both chroma
  blocks keep whatever the previous tile left behind. This hits macro-block codes 5/6/7/13/14/15,
  the cheap flat-tile path a text console is mostly made of.
- **The resolution guard rejects the resolution that actually works.** `MAX_RESOLUTION` in
  `client/codec/decoder.js` is 1500, and `decodeFrame` takes `destX`/`destY` as the full frame
  geometry, so both 1600x1200 and 1920x1200 throw.
  [`studies/ast2500-display-and-capture-ceilings.md`](studies/ast2500-display-and-capture-ceilings.md)
  establishes 1920x1200 as both the hardware ceiling and the one mode a headless AST board
  reliably reaches — 1080p being blocked by an upstream DMT sync-polarity bug.
- **Multi-fragment continuation is not implemented.** Only a full frame arriving in a single
  `CMD_VIDEO_PACKETS` payload decodes; the vendor client's `prev_complete` continuation path has
  no equivalent here.
- **The protocol facts are undocumented and there is no fixture.** `docs/codec-notes.md` does not
  exist, and `experiments/` holds no capture — so the JPEG path's verification against a live
  frame is not reproducible, and the VQ defect above has nothing to be tested against. Writing
  that document is also what carries the clean-room posture: it is the record of which protocol
  facts came from a live capture rather than from the vendor's own JS.

Two open questions gate the proxy and its module
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
| `flake.nix` | `nixosModules.nixbmc`/`.default`, `systemManagerModules.nixbmc`/`.default` (BMC access, real); `checks`. `nixosModules.kvm` lands once the open questions above are resolved. |
| `modules/nixbmc.nix` | `nixbmc.*` option schema + the platform-neutral `archPackages`/`aurPackages` resolution. Installs nothing itself. |
| `modules/nixos.nix` | NixOS backend — `environment.systemPackages` + `boot.kernelModules` (the latter gated on `ipmitool.inBand`). |
| `modules/arch.nix` | Arch/system-manager backend — publishes `archPackages`/`aurPackages` for a consumer's own reconciler; asserts at eval time if `ipmitool.inBand` is left `true` on a plane with no `boot.kernelModules`. |
| `checks/default.nix` | Eval-time proof of the `nixbmc.*` option surface, both directions, both backends. Covers `nixbmc.*` only — the codec has no tests. |
| `client/codec/` | Clean-room JS port of the ASPEED KVM video codec (VQ + JPEG + RC4 + YUV→BGR), pre-alpha — see "Status" for its defects. No transport, session, render or input layer exists yet. |
| `experiments/` | Throwaway trials — see [`experiments/README.md`](experiments/README.md). |
| `studies/` | Written-up findings — see [`studies/README.md`](studies/README.md). |

## Related projects

nixbmc is one of several small, independently-usable open-source projects
sharing a common design system: [nixarch](https://github.com/julian-corbet/nixarch-corbet-ch),
nixvps, nixram, nixnas, [nixremote](https://github.com/julian-corbet/nixremote-corbet-ch),
[nixsh](https://github.com/julian-corbet/nixsh-corbet-ch), and
[nixpower](https://github.com/julian-corbet/nixpower-corbet-ch) (the power-stance mechanism
`nixbmc.*` deliberately stays out of — see "BMC access" above; nixpower's own module
names this repo by reference for anything BMC-shaped). Its niche is a BMC's own surfaces —
in-band and out-of-band-client CLI access today, a browser console protocol once the KVM
viewer lands — narrow by design, useful to anyone with the same class of hardware regardless
of whether they run anything else in this family.

## License

[MIT License](LICENSE) © 2026 Julian Corbet
