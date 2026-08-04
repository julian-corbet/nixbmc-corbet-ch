# modules/nixos.nix
#
# NixOS backend for nixbmc -- resolves the option surface into environment.systemPackages and
# boot.kernelModules. The one backend that CAN reach boot.kernelModules at all; system-manager
# (modules/arch.nix) has no such option, which is the entire reason this repo is split into
# three files instead of one -- see modules/nixbmc.nix's own header.
{ config
, lib
, pkgs
, ...
}:
let
  cfg = config.nixbmc;
in
{
  imports = [ ./nixbmc.nix ];

  config = lib.mkIf cfg.enable {
    environment.systemPackages =
      lib.optional cfg.ipmitool.enable pkgs.ipmitool
      ++ lib.optional cfg.flashrom.enable pkgs.flashrom;

    # `ipmi_devintf` and `ipmi_si` are pulled in explicitly rather than left to autoload: on a
    # board where the kernel already autoloads them this is a harmless no-op, but /dev/ipmi0 is
    # the entire interface -- without it ipmitool fails with a confusing "Could not open device"
    # that reads like a permissions problem rather than a missing module. Declaring them
    # explicitly costs nothing and removes that failure mode.
    #
    # Gated on `ipmitool.inBand` (default true, byte-identical to this module's original
    # single-host-only behaviour): a host reaching a BMC purely out-of-band
    # (`ipmitool.inBand = false`) has no /dev/ipmi0 of its own to open and gets no benefit from
    # either module -- loading them would be dead weight at best and, on hardware with an
    # unrelated IPMI-shaped device, a genuine footgun at worst.
    boot.kernelModules = lib.optionals (cfg.ipmitool.enable && cfg.ipmitool.inBand) [
      "ipmi_devintf"
      "ipmi_si"
    ];
  };
}
