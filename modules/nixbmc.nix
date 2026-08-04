# modules/nixbmc.nix
#
# nixbmc — baseboard management controller (BMC) access, platform-neutral half: the option
# schema and the resolution of those options into package names. Installs nothing itself; see
# modules/nixos.nix (environment.systemPackages + boot.kernelModules) and modules/arch.nix
# (publishes archPackages/aurPackages for a consumer's own reconciler, because on Arch this
# module has no installer of its own) -- same three-file split as nixdev/nixoffice in this
# design-system family, and for the same reason: `boot.kernelModules` does not exist on the
# system-manager plane, so a shared file cannot set it, and each backend needs its own.
#
# SCOPE -- still no BMC IP, no credentials, nothing to unseal, on EITHER backend. That holds
# regardless of `ipmitool.inBand`: what that option changes is which INTERFACE ipmitool expects
# to find (the in-band /dev/ipmi0 KCS/SSIF device on this box, or nothing local at all), never
# whether this module knows a BMC's address or password. An out-of-band caller
# (`ipmitool -I lanplus -H <bmc-ip> -U ... -P ...`) supplies those itself, at the command line,
# exactly the way it always has -- this module only ever gets the binary onto $PATH. A REMOTE leg
# (Redfish/HTTPS, with BMC credentials sourced from a secrets manager) is a genuinely different
# concern -- different transport, different auth, different failure mode -- and stays out of
# scope for this module entirely, the same as before.
#
# WHY ITS OWN NAMESPACE, RATHER THAN A LINE IN A POWER-STANCE MODULE: a BMC is a whole second
# computer inside the box, with its own firmware, its own network stack (when reached
# remotely) and its own view of the hardware. It ANSWERS power questions (wattage, PSU state,
# thermals) but it is not a power knob, and folding its tooling into a power-stance module
# makes both harder to reason about -- a host that only wants a power reading should not
# silently acquire a firmware-flashing utility as a side effect of asking for one.
#
# One option per tool, for the identical reason at a smaller scale: `ipmitool.enable` and
# `flashrom.enable` are independent, so a host that only ever wants `ipmitool dcmi power
# reading` gets no flashrom binary it never asked for, and vice versa.
{ config
, lib
, ...
}:
let
  cfg = config.nixbmc;
in
{
  options.nixbmc = {
    enable = lib.mkEnableOption "nixbmc: baseboard management controller access";

    ipmitool.enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        ipmitool. WHICH interface it talks over is `ipmitool.inBand`, below -- this flag alone
        only puts the binary on $PATH.

        The tool that turns power work from estimates into numbers:

          ipmitool dcmi power reading     # whole-chassis draw, in watts
          ipmitool sdr type Temperature   # BMC's own thermal view
          ipmitool sel list                # hardware event log (PSU, ECC, thermal)

        (the three examples above assume `ipmitool.inBand = true`, this box's own BMC; an
        out-of-band caller adds `-I lanplus -H <bmc-ip> -U <user> -P <password>` to each).
      '';
    };

    ipmitool.inBand = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Whether this host reaches ITS OWN BMC over the in-band KCS/SSIF interface (true, the
        default -- byte-identical to this module's original single-host behaviour), or is
        purely an OUT-OF-BAND client of a DIFFERENT machine's BMC over the network (false).

        true additionally pulls in the `ipmi_devintf` and `ipmi_si` kernel modules and expects
        /dev/ipmi0 on THIS box -- see the NixOS backend for why they're declared explicitly
        rather than left to autoload. Meaningless without a real local BMC; a host with none
        gets nothing from it (and the Arch/system-manager backend refuses it outright -- see
        modules/arch.nix, since it has no boot.kernelModules to honour the request with).

        false installs the `ipmitool` binary ONLY -- no kernel module, no /dev/ipmi0 assumption
        -- for a host with no BMC of its own that reaches someone else's over the LAN:

          ipmitool -I lanplus -H <bmc-ip> -U <user> -P <password> chassis power status

        This adds no credential or transport handling for that path -- `-H`/`-U`/`-P` (or
        `-E`/`IPMI_PASSWORD`) are the operator's to supply at the command line, matching this
        module's own no-credentials scope (see this file's header). Ignored entirely when
        `ipmitool.enable` is false.
      '';
    };

    flashrom.enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        flashrom, for reading/writing SPI NOR flash chips directly with an external
        programmer (e.g. a CH341A + SOIC-8 clip). This module installs the CLI only -- it
        does NOT vouch for `-p internal` live self-flashing on any particular chipset: some
        AMD FCH/Promontory-family chipsets have had a system-crash-capable bug in that
        internal-programmer path, fixed only in a relatively recent flashrom release, with
        thin public precedent across boards sharing that chipset generation and at least one
        report of an unresolved live write leaving the chip in an unknown state. Verify
        current flashrom + chipset compatibility for the exact board before ever pointing
        this at `-p internal`.

        The lever this module is actually installed for is the clip-mode recovery path: a
        clip read/write bypasses the BMC chip and the host chipset entirely and talks
        straight to the generic SPI NOR part, so the same tool and physical clip cover BOTH a
        host BIOS chip and a BMC's own flash chip if a vendor flash (BIOS via the BMC GUI, or
        an OpenBMC install) goes wrong and leaves either chip unbootable. Passive until
        someone plugs in a programmer -- installing it costs nothing on its own.
      '';
    };

    # ── Computed, read-only -- the contract a platform backend consumes ─────────────────────
    archPackages = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      readOnly = true;
      description = ''
        The enabled tools as pacman package names.

        This module cannot install them: on Arch there is no installer here to call. Feed it to
        whatever reconciler the host uses, e.g.

          nixarch.packages.pacman = config.nixbmc.archPackages;

        Kept as a plain list rather than wired into any particular reconciler on purpose --
        that would couple this flake to one consumer's package module.
      '';
    };

    aurPackages = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      readOnly = true;
      description = ''
        Kept for shape-consistency with the rest of this design-system family (nixdev and
        nixoffice both publish the identical pair), even though it is always empty today:
        ipmitool and flashrom are both official-repo Arch packages, never AUR-only. A consumer
        wiring `nixarch.packages.aur = config.nixbmc.aurPackages;` unconditionally, alongside
        every other catalogue in the family, needs no special case for this one.
      '';
    };
  };

  config = {
    nixbmc.archPackages =
      lib.optional (cfg.enable && cfg.ipmitool.enable) "ipmitool"
      ++ lib.optional (cfg.enable && cfg.flashrom.enable) "flashrom";
    nixbmc.aurPackages = [ ];
  };
}
