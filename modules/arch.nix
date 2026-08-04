# modules/arch.nix
#
# Arch/system-manager backend for nixbmc -- publishes the selections as pacman package names;
# installs nothing itself, because on Arch this module has no installer to call. Packages arrive
# through whatever reconciler the host runs (nixarch's `nixarch.packages.pacman`, for the
# deployment this family was written for). Wiring that reconciler in here would couple a general
# flake to one consumer's module, so the list is published and the consumer connects it:
#
#   nixarch.packages.pacman = config.nixbmc.archPackages;
#
# Sets NOTHING NixOS-only -- no environment.systemPackages (system-manager has no installer of
# its own to feed it; see above), and no boot.kernelModules, which does not exist as an option
# on this plane at all. That absence is exactly why `ipmitool.inBand = true` (the default) needs
# the assertion below rather than silently doing nothing: a host on THIS backend genuinely
# cannot load ipmi_devintf/ipmi_si, so leaving the in-band default untouched would claim a
# local-BMC interface this plane can never provide, with no error and no visible symptom either
# -- the "ipmitool.enable = true installs ipmitool" contract every other option here upholds.
{ config
, lib
, ...
}:
let
  cfg = config.nixbmc;
in
{
  imports = [ ./nixbmc.nix ];

  config = {
    # ASSERTION, not a forced override (`lib.mkForce cfg.ipmitool.inBand false`): this repo's own
    # checks/default.nix header states the family's rule plainly -- "disabled means nothing, not
    # loaded with defaults" -- and the inverse holds just as much here. Silently overriding a
    # user's `inBand = true` would make the option lie about what it did; an eval-time error
    # instead tells the operator to either flip it explicitly or move `ipmitool.enable` to a host
    # that actually owns a local BMC. nixarch and nixremote (this family's other modules) both
    # use `assertions` for the identical kind of "this shape cannot be satisfied on this plane"
    # eval-time error, so this follows the same idiom rather than inventing a new one.
    assertions = [
      {
        assertion = !(cfg.enable && cfg.ipmitool.enable && cfg.ipmitool.inBand);
        message = ''
          nixbmc.ipmitool.inBand = true (the default) has no effect on the Arch/system-manager
          backend: this plane has no `boot.kernelModules` to load ipmi_devintf/ipmi_si into, and
          no /dev/ipmi0 of its own to expect. Set nixbmc.ipmitool.inBand = false for a host that
          is purely an out-of-band client of a DIFFERENT machine's BMC
          (`ipmitool -I lanplus -H <bmc-ip> ...`), or put ipmitool.enable on the NixOS backend
          instead if this box genuinely owns a local BMC.
        '';
      }
    ];
  };
}
