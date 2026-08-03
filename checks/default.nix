# checks/default.nix
#
# Proves the nixbmc option surface behaves, both directions: enabling `nixbmc.ipmitool`/
# `.flashrom` produces exactly the expected package + kernel-module entries, and a disabled
# module (the default, and every "enable=true but every tool left off" shape) produces
# NOTHING -- not defaults, nothing at all.
#
# WHY A HAND-STUBBED `lib.evalModules` AND NOT NixOS's OWN eval-config.nix: a real NixOS
# system composes hundreds of default modules, which means `environment.systemPackages` and
# `boot.kernelModules` are never actually empty on a real system -- the base profile alone
# populates dozens of packages and a handful of autodetected kernel modules (confirmed by
# hand: eval-config.nix's own default system put ~80 packages and ["atkbd" "loop"] into those
# two lists before this module ever touched them). Testing "disabled produces []" against
# that would be testing NixOS's base profile, not this module. A minimal stub declaring only
# the two options this module actually writes -- both defaulting to `[]`, exactly like the
# real NixOS options do -- makes "nothing" a checkable, exact value instead of an unknowable
# moving target, at the cost of not exercising the two option TYPES themselves (already
# ordinary/well-tested NixOS primitives, not this module's own risk surface).
{ pkgs, lib, nixbmcModule }:
let
  stub = {
    options.environment.systemPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
    };
    options.boot.kernelModules = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
    };
  };

  evalNixbmc =
    settings:
    (lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        stub
        nixbmcModule
        { nixbmc = settings; }
      ];
    }).config;

  check = name: ok: detail: { inherit name ok detail; };

  results = [
    # ── DISABLED MEANS NOTHING, not "loaded with defaults" ──────────────────────────────────
    (check "the module is disabled by default: no packages, no kernel modules"
      (
        let
          c = evalNixbmc { };
        in
        c.environment.systemPackages == [ ] && c.boot.kernelModules == [ ]
      )
      "expected environment.systemPackages == [] and boot.kernelModules == [] with nixbmc left entirely unconfigured"
    )

    (check "nixbmc.enable = true with both tools left at their false default installs and loads nothing"
      (
        let
          c = evalNixbmc { enable = true; };
        in
        c.environment.systemPackages == [ ] && c.boot.kernelModules == [ ]
      )
      "ipmitool.enable and flashrom.enable both default to false -- the top-level enable alone must be a no-op"
    )

    (check "a sub-tool enabled without the top-level nixbmc.enable does nothing"
      (
        let
          c = evalNixbmc { ipmitool.enable = true; };
        in
        c.environment.systemPackages == [ ] && c.boot.kernelModules == [ ]
      )
      "config is behind lib.mkIf cfg.enable -- the top-level gate must be respected even when a sub-tool is individually turned on"
    )

    # ── ipmitool: package + BOTH kernel modules, and nothing flashrom-shaped ────────────────
    (check "ipmitool.enable installs ipmitool and loads exactly ipmi_devintf + ipmi_si"
      (
        let
          c = evalNixbmc {
            enable = true;
            ipmitool.enable = true;
          };
        in
        c.environment.systemPackages == [ pkgs.ipmitool ] && c.boot.kernelModules == [ "ipmi_devintf" "ipmi_si" ]
      )
      "expected systemPackages == [ipmitool] and kernelModules == [ipmi_devintf ipmi_si] with only ipmitool.enable set"
    )

    # ── flashrom: package only, no kernel modules ───────────────────────────────────────────
    (check "flashrom.enable installs flashrom and loads no kernel modules at all"
      (
        let
          c = evalNixbmc {
            enable = true;
            flashrom.enable = true;
          };
        in
        c.environment.systemPackages == [ pkgs.flashrom ] && c.boot.kernelModules == [ ]
      )
      "flashrom needs no in-band IPMI kernel interface -- boot.kernelModules must stay empty with only flashrom.enable set"
    )

    # ── both together: both packages, still only the IPMI modules (flashrom contributes none) ─
    (check "both tools enabled together install both packages and only the IPMI kernel modules"
      (
        let
          c = evalNixbmc {
            enable = true;
            ipmitool.enable = true;
            flashrom.enable = true;
          };
        in
        c.environment.systemPackages == [ pkgs.ipmitool pkgs.flashrom ] && c.boot.kernelModules == [ "ipmi_devintf" "ipmi_si" ]
      )
      "expected both packages present, in ipmitool-then-flashrom option-declaration order, and kernelModules unaffected by flashrom.enable"
    )
  ];

  failed = builtins.filter (r: !r.ok) results;
  report = lib.concatMapStringsSep "\n" (r: "  - ${r.name}: ${r.detail}") failed;
in
{
  # Named, like nixwatch's own checks/default.nix -- `checks.<system>` is an attrset of
  # derivations, not one derivation, so this stays `{ eval-tests = ...; }` even though there
  # is only one check here today.
  eval-tests =
    if failed == [ ] then
      pkgs.runCommand "nixbmc-eval-tests" { passedCount = toString (builtins.length results); } ''
        echo "all $passedCount nixbmc eval tests passed"
        touch $out
      ''
    else
      throw ''
        nixbmc eval-tests FAILED (${toString (builtins.length failed)}/${toString (builtins.length results)}):
        ${report}
      '';
}
