# What an AST2500 can actually put on screen — and what the capture engine can take

Why this matters to nixbmc: the client has to render whatever the BMC captures, and the BMC can
only ever capture what the ASPEED chip's own VGA controller is scanning out. So the resolution the
client must handle, and the frame rate it can hope for, are both decided *before* the protocol
starts. This study establishes those ceilings from primary sources, and explains the very common
"my server console is stuck at 1024x768" case — which is a host-side mode-validation problem, not a
BMC one.

Everything below is from the ASPEED AST2500/AST2520 A2 datasheet (v1.6), the mainline Linux `ast`
DRM driver, and the mainline `aspeed-video` V4L2 driver, plus one live board used to confirm the
behaviour.

## Three different ceilings, routinely conflated

| Ceiling | Value | Source |
|---|---|---|
| 2D display controller | 1920x1200 32bpp @60Hz, **165 MHz max pixel clock** | datasheet §1.3.5 |
| iKVM video capture engine | 1920x1200 | `MAX_WIDTH`/`MAX_HEIGHT` in `drivers/media/platform/aspeed/aspeed-video.c` |
| Linux `ast` driver | 1920 wide **only if** `support_fullhd`, else 1600x1200 | `ast_mode.c` |

Practical consequence: **there is no 4K, and no 2560x1440.** 3840x2160@60 needs ~594 MHz against a
165 MHz PLL. A client should treat 1920x1200 as the absolute upper bound on frame geometry and can
size its decode buffers accordingly.

## The capture engine only ever sees the chip's own VGA controller

The Video Engine reads either the internal VGA controller's live RGB stream ("video capture mode")
or its framebuffer directly ("quick fetch mode") — datasheet Ch.33 §33.2, and register `VR008`
bit 2 selects internal VGA vs. an external DVO source. On a normal server board nothing is wired to
the external input. The mainline driver agrees: it exposes exactly two V4L2 inputs,
`{"HOST VGA", "BMC GFX"}`, where `BMC GFX` is the BMC's *own* SoC display controller, not an x86
host's discrete GPU.

So if a host renders on a discrete GPU, the BMC shows a **stale frame**, not a black screen and not
the GPU's output. There is no software fix; there is no hardware path. This is worth stating plainly
in user-facing docs, because it is a recurring support question.

## Two compression paths, very different cost

- **Text / legacy VGA modes** use *video capture mode* plus the hardware **Block Change Detection**
  engine (`VR02C`), which re-encodes only 8x8/16x16 blocks that changed. A static text console
  costs close to nothing.
- **16/32bpp graphics modes** use *quick fetch mode*, periodically reading the framebuffer, and
  require giving up hardware cursor compositing ("cursor overlay will be done in client site" —
  i.e. **the client must draw the pointer itself**; relevant to nixbmc's input/render design).

The only throughput figure the vendor publishes is **30 fps at 1280x1024 32bpp@60 under YUV420**.
No fps target is stated for 1080p or 1200p — the omission is informative. YUV444 is documented as
higher quality / lower frame rate.

Documented levers that reduce engine work, for a "tuning" section in the docs: lower resolution,
16bpp instead of 32bpp (`VR008` bit 4, halves framebuffer read volume), disabling BMC-side hardware
cursor overlay (`VR008` bit 8), and reducing on-screen change rate. No measured before/after numbers
appear to exist publicly for any of these — flagged as unquantified.

## Mode changes drop the session — the client must handle it

The engine has a hardware mode-detect watchdog. On any host resolution/timing change it fires an
interrupt; the driver immediately sets `V4L2_IN_ST_NO_SIGNAL` and queues
`V4L2_EVENT_SOURCE_CHANGE` / `V4L2_EVENT_SRC_CH_RESOLUTION`. Userspace must stop, re-query geometry
and restart capture. Corroborated by the kernel fix "media: aspeed: Fix signal status not updated
immediately", which addresses a race where the *old* resolution was briefly used after a change.

**Client implication:** firmware→bootloader→kernel handoffs, and any in-OS resolution change, will
visibly drop and reconnect the stream. A client that treats a mid-session geometry change as a fatal
error will look broken exactly when it is most needed (during boot). Handle it as a normal event and
re-negotiate.

## Why so many AST2500 consoles are stuck at 1024x768

Headless servers usually have nothing on the VGA port, so there is no EDID. In
`ast_vga_connector_helper_get_modes()`:

```c
if (ast_connector->physical_status == connector_status_connected) {
        count = drm_connector_helper_get_modes(connector);   /* EDID path */
} else {
        drm_edid_connector_update(connector, NULL);          /* discards any software EDID */
        count = drm_add_modes_noedid(connector, 4096, 4096);
        if (count)
                drm_set_preferred_mode(connector, 1024, 768);
}
```

Two consequences that surprise people:

1. **Software EDID injection does not work with nothing plugged in.** `drm.edid_firmware=` and the
   debugfs `edid_override` are both honoured only on the connected branch, and the other branch
   actively clears the EDID on every probe. Confirmed live: writing a valid, checksum-correct
   1080p EDID left `/sys/class/drm/card0-VGA-1/edid` at 0 bytes. Anything that answers DDC — a
   passive EDID-emulator dongle is sufficient, it need not be a display — flips the branch and makes
   software EDID work again.
2. **`video=<connector>:1920x1080@60` on the kernel cmdline fails**, logging
   `User-defined mode not supported`. The root cause is an upstream kernel bug, not an ASPEED one.
   `drm_edid.c` carries 1920x1080@60 **twice, with contradictory sync polarity**:

   | Table | Timing | Sync |
   |---|---|---|
   | `drm_dmt_modes[]` 0x52 | 148500, 1920 2008 2052 2200 / 1080 1084 1089 1125 | **`NHSYNC \| NVSYNC`** |
   | CTA-861 VIC 16 | byte-for-byte identical | `PHSYNC \| PVSYNC` |

   VESA DMT 1.0 rev 13 defines ID 0x52 as sharing CTA-861 Format 16 timing, i.e.
   **positive/positive** — the DMT entry is wrong. `drm_add_modes_noedid()` reads *only*
   `drm_dmt_modes[]`, so the mode reaches the driver −/− while `res_1920x1080[]` in `ast_vbios.c`
   requires `SyncPP`; `ast_vbios_find_mode()` filters on polarity and discards it. No cmdline
   syntax can express +/+ either: plain gives −/−, `M` (CVT) gives −h/+v, `MR` (CVT-RB) gives
   +h/−v. Verified in v7.1 and v6.12; a one-line fix to the DMT flags restores FullHD on any
   headless AST board and is worth carrying upstream.

**1920x1200 does work**, where 1080p does not, because `res_1920x1200[]` is the *reduced-blanking*
timing (154 MHz, `SyncNP`, htotal 2080 / vtotal 1235) and matches the kernel's DMT 1920x1200 RB
entry exactly — so it is already in the probed list and the cmdline merely selects it. Adding the
`e` suffix (`DRM_FORCE_ON`) makes this deterministic, because `drm_helper_probe_detect()` then skips
the driver's `detect_ctx` and `physical_status` can never latch to `connected` on a flaky DDC probe.

Also note the widescreen gate: `support_fullhd` / `support_wsxga_p` are derived from `VGACRD0`
(`__ast_2100_detect_wsxga_p`, `ast_2100.c`) — bit 7 `VRAM_INIT_BY_BMC`, bit 0 `IKVM_WIDESCREEN`,
the latter set by BMC firmware at POST. That register is not readable from userspace on a host with
`CONFIG_IO_STRICT_DEVMEM=y`. The practical test is indirect: **if 1920x1200 appears in the
connector's mode list, the gate is open.** If the list tops out at 1600x1200, it is not.

## Takeaways for nixbmc

- Size the client for a **1920x1200 maximum**; never advertise 4K.
- **Draw the cursor client-side** — the hardware overlay is off in quick-fetch/graphics mode by design.
- **Treat resolution change as a routine event**, not an error; it happens on every boot handoff.
- Expect **very different frame rates for text vs. graphics** consoles; a static text screen is
  nearly free, a graphical desktop is not, and the vendor's own best case is 30 fps at 1280x1024.
- Worth a FAQ entry: "my console is 1024x768 and `video=` does nothing" has a precise, documented
  cause and two fixes (use 1920x1200, or add a DDC source and inject EDID).
