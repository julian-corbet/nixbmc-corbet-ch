# nixbmc

A clean-room, browser-native replacement for the flaky bundled KVM viewer on
AMI MegaRAC-family BMCs (AST2500/AST2600, the same firmware lineage shipped by
Gigabyte, Supermicro, ASRock Rack, Tyan, and Lenovo).

## Vision

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

**Pre-alpha — scaffold only, no module written yet.** Blocked on two open
questions before the first line of the actual client/proxy gets written
(bringing these here rather than guessing, per the project's own "no MVP,
build the right end state" habit — guessing wrong on either one means
reworking the module's shape, not just a config tweak):

1. **Where does the proxy run?** The whole point of the AST2500 KVM leg (in
   the wider the build host command-central plan this project split off from)
   is pre-boot / degraded-state access — reachable when the pools are down or
   k3s itself isn't up. Running nixbmc *as a k3s app* would make it share fate
   with exactly the failure modes it's meant to survive. Leaning towards: a
   small bare-metal NixOS-declared systemd service on the build host itself
   (same posture as `rescue-maintain` / other bare-metal-declared services),
   not a k3s deployment.
2. **Exposure model.** NetBird-only (matches how sensitive out-of-band access
   is generally treated — full HID/keyboard/mouse control of the physical
   host is a bigger blast radius than most fleet services), or also reachable
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
| `flake.nix` | Flake entry point. `nixosModules.kvm` lands once the open questions above are resolved. |
| `experiments/` | Throwaway trials — see [`experiments/README.md`](experiments/README.md). |
| `studies/` | Written-up findings — see [`studies/README.md`](studies/README.md). |

## Related projects

nixbmc is one of several small, independently-usable open-source projects
sharing a common design system: [nixarch](https://github.com/julian-corbet/nixarch-corbet-ch),
nixvps, nixram, nixnas, [nixremote](https://github.com/julian-corbet/nixremote-corbet-ch),
[nixfish](https://github.com/julian-corbet/nixfish-corbet-ch). Its niche is a
single out-of-band console protocol — narrow by design, useful to anyone with
the same BMC generation regardless of whether they run anything else in this
family.

## License

[MIT License](LICENSE) © 2026 Julian Corbet
