# modules/default.nix
#
# nixbmc: local baseboard management controller (BMC) access -- ipmitool (plus the in-band
# IPMI kernel interface it needs) and/or flashrom, declared once instead of reached for by
# hand on whichever box happens to need them.
#
# SCOPE -- the LOCAL leg only, over the in-band KCS/SSIF interface: no network, no BMC IP, no
# credentials, nothing to unseal. A REMOTE leg (Redfish/HTTPS, with BMC credentials from a
# secrets manager) is a genuinely different concern -- different transport, different auth,
# different failure mode -- and out of scope for this module entirely. The browser-native KVM
# viewer this repo's README describes is a separate, still-scaffold piece of the eventual
# REMOTE-leg story for display/input on the same class of board; this module does not depend
# on it, and works whether or not it ever lands.
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
, pkgs
, ...
}:
let
  cfg = config.nixbmc;
in
{
  options.nixbmc = {
    enable = lib.mkEnableOption "nixbmc: local baseboard management controller access";

    ipmitool.enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        ipmitool, plus the in-band IPMI kernel interface it needs.

        The tool that turns power work from estimates into numbers:

          ipmitool dcmi power reading     # whole-chassis draw, in watts
          ipmitool sdr type Temperature   # BMC's own thermal view
          ipmitool sel list               # hardware event log (PSU, ECC, thermal)

        `ipmi_devintf` and `ipmi_si` are pulled in explicitly rather than left to autoload: on
        a board where the kernel already autoloads them this is a harmless no-op, but
        /dev/ipmi0 is the entire interface -- without it ipmitool fails with a confusing
        "Could not open device" that reads like a permissions problem rather than a missing
        module. Declaring them explicitly costs nothing and removes that failure mode.

        Local interface only: no BMC IP, no credentials, nothing to unseal. A box whose BMC
        is reachable only over the network gets no benefit from this.
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
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages =
      lib.optional cfg.ipmitool.enable pkgs.ipmitool
      ++ lib.optional cfg.flashrom.enable pkgs.flashrom;

    boot.kernelModules = lib.optionals cfg.ipmitool.enable [
      "ipmi_devintf"
      "ipmi_si"
    ];
  };
}
