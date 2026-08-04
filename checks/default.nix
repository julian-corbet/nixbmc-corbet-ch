# checks/default.nix
#
# Proves the nixbmc option surface behaves, both directions and both backends: enabling
# `nixbmc.ipmitool`/`.flashrom` produces exactly the expected package + kernel-module entries (or
# archPackages entries, on the Arch/system-manager side), and a disabled module (the default, and
# every "enable=true but every tool left off" shape) produces NOTHING -- not defaults, nothing at
# all. `ipmitool.inBand` gets the same both-directions treatment: true (the default) loads the
# kernel modules on NixOS, false installs the binary and touches nothing kernel-shaped, and on
# the Arch backend true raises an eval-time assertion rather than silently doing nothing.
#
# WHY A HAND-STUBBED `lib.evalModules` AND NOT NixOS's OWN eval-config.nix: a real NixOS
# system composes hundreds of default modules, which means `environment.systemPackages` and
# `boot.kernelModules` are never actually empty on a real system -- the base profile alone
# populates dozens of packages and a handful of autodetected kernel modules (confirmed by
# hand: eval-config.nix's own default system put ~80 packages and ["atkbd" "loop"] into those
# two lists before this module ever touched them). Testing "disabled produces []" against
# that would be testing NixOS's base profile, not this module. A minimal stub declaring only
# the surface this module actually writes makes "nothing" a checkable, exact value instead of
# an unknowable moving target, at the cost of not exercising the option TYPES themselves
# (already ordinary/well-tested NixOS primitives, not this module's own risk surface).
#
# TWO STUBS, DELIBERATELY DIFFERENT SHAPES. The NixOS stub carries `environment.systemPackages`
# and `boot.kernelModules`, the two surfaces modules/nixos.nix writes into. The Arch stub carries
# neither `environment.systemPackages` (modules/arch.nix never writes it -- see that file's own
# header for why) NOR `boot.kernelModules`: that option genuinely does not exist on the
# system-manager plane, so a check exercising this backend must fail LOUDLY -- an eval-time "the
# option does not exist" error, not a silently-ignored write -- if modules/arch.nix ever regresses
# into trying to set it. `assertions` is stubbed on the Arch side because a real system-manager
# tree provides it itself, the same convention nixarch's and nixremote's own checks/default.nix
# already stub it under.
{ pkgs, lib, nixosModule, archModule }:
let
  nixosStub = {
    options.environment.systemPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
    };
    options.boot.kernelModules = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
    };
  };

  evalNixos =
    settings:
    (lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        nixosStub
        nixosModule
        { nixbmc = settings; }
      ];
    }).config;

  archStub = {
    options.assertions = lib.mkOption {
      type = lib.types.listOf lib.types.attrs;
      default = [ ];
    };
  };

  evalArch =
    settings:
    (lib.evalModules {
      modules = [
        archStub
        archModule
        { nixbmc = settings; }
      ];
    }).config;

  failedAssertionMessages = c: map (a: a.message) (lib.filter (a: !a.assertion) c.assertions);

  check = name: ok: detail: { inherit name ok detail; };

  results = [
    # ── DISABLED MEANS NOTHING, not "loaded with defaults" (NixOS backend) ──────────────────
    (check "nixos: the module is disabled by default: no packages, no kernel modules"
      (
        let
          c = evalNixos { };
        in
        c.environment.systemPackages == [ ] && c.boot.kernelModules == [ ]
      )
      "expected environment.systemPackages == [] and boot.kernelModules == [] with nixbmc left entirely unconfigured"
    )

    (check "nixos: nixbmc.enable = true with both tools left at their false default installs and loads nothing"
      (
        let
          c = evalNixos { enable = true; };
        in
        c.environment.systemPackages == [ ] && c.boot.kernelModules == [ ]
      )
      "ipmitool.enable and flashrom.enable both default to false -- the top-level enable alone must be a no-op"
    )

    (check "nixos: a sub-tool enabled without the top-level nixbmc.enable does nothing"
      (
        let
          c = evalNixos { ipmitool.enable = true; };
        in
        c.environment.systemPackages == [ ] && c.boot.kernelModules == [ ]
      )
      "config is behind lib.mkIf cfg.enable -- the top-level gate must be respected even when a sub-tool is individually turned on"
    )

    # ── ipmitool, in-band (default): package + BOTH kernel modules, nothing flashrom-shaped ──
    (check "nixos: ipmitool.enable (inBand default true) installs ipmitool and loads exactly ipmi_devintf + ipmi_si"
      (
        let
          c = evalNixos {
            enable = true;
            ipmitool.enable = true;
          };
        in
        c.environment.systemPackages == [ pkgs.ipmitool ] && c.boot.kernelModules == [ "ipmi_devintf" "ipmi_si" ]
      )
      "expected systemPackages == [ipmitool] and kernelModules == [ipmi_devintf ipmi_si] with only ipmitool.enable set (inBand left at its default)"
    )

    (check "nixos: ipmitool.enable with inBand explicitly true still loads exactly ipmi_devintf + ipmi_si (regression guard on the default)"
      (
        let
          c = evalNixos {
            enable = true;
            ipmitool = { enable = true; inBand = true; };
          };
        in
        c.environment.systemPackages == [ pkgs.ipmitool ] && c.boot.kernelModules == [ "ipmi_devintf" "ipmi_si" ]
      )
      "an explicit inBand = true must behave identically to the implicit default -- same packages, same kernel modules"
    )

    # ── ipmitool, out-of-band client (inBand = false): binary only, ZERO kernel modules ─────
    (check "nixos: ipmitool.enable with inBand = false installs ipmitool and loads zero kernel modules"
      (
        let
          c = evalNixos {
            enable = true;
            ipmitool = { enable = true; inBand = false; };
          };
        in
        c.environment.systemPackages == [ pkgs.ipmitool ] && c.boot.kernelModules == [ ]
      )
      "an out-of-band-only client has no /dev/ipmi0 of its own -- inBand = false must install the binary and load NO kernel module at all"
    )

    # ── flashrom: package only, no kernel modules, unaffected by inBand ─────────────────────
    (check "nixos: flashrom.enable installs flashrom and loads no kernel modules at all"
      (
        let
          c = evalNixos {
            enable = true;
            flashrom.enable = true;
          };
        in
        c.environment.systemPackages == [ pkgs.flashrom ] && c.boot.kernelModules == [ ]
      )
      "flashrom needs no in-band IPMI kernel interface -- boot.kernelModules must stay empty with only flashrom.enable set"
    )

    # ── both together: both packages, still only the IPMI modules (flashrom contributes none) ─
    (check "nixos: both tools enabled together install both packages and only the IPMI kernel modules"
      (
        let
          c = evalNixos {
            enable = true;
            ipmitool.enable = true;
            flashrom.enable = true;
          };
        in
        c.environment.systemPackages == [ pkgs.ipmitool pkgs.flashrom ] && c.boot.kernelModules == [ "ipmi_devintf" "ipmi_si" ]
      )
      "expected both packages present, in ipmitool-then-flashrom option-declaration order, and kernelModules unaffected by flashrom.enable"
    )

    # ── archPackages: the platform-neutral output both backends can read ────────────────────
    (check "archPackages is empty when the module is disabled"
      ((evalNixos { }).nixbmc.archPackages == [ ])
      "expected nixbmc.archPackages == [] with nixbmc left entirely unconfigured"
    )

    (check "archPackages contains ipmitool when ipmitool.enable is set"
      ((evalNixos { enable = true; ipmitool.enable = true; }).nixbmc.archPackages == [ "ipmitool" ])
      "expected nixbmc.archPackages == [\"ipmitool\"] with only ipmitool.enable set"
    )

    (check "archPackages contains flashrom when flashrom.enable is set, and both when both are"
      (
        (evalNixos { enable = true; flashrom.enable = true; }).nixbmc.archPackages == [ "flashrom" ]
        && (evalNixos { enable = true; ipmitool.enable = true; flashrom.enable = true; }).nixbmc.archPackages == [ "ipmitool" "flashrom" ]
      )
      "expected [\"flashrom\"] with only flashrom.enable set, and [\"ipmitool\" \"flashrom\"] with both -- inBand plays no part in archPackages either way"
    )

    (check "aurPackages is always empty -- ipmitool and flashrom are both official-repo, never AUR-only"
      (
        (evalNixos { }).nixbmc.aurPackages == [ ]
        && (evalNixos { enable = true; ipmitool.enable = true; flashrom.enable = true; }).nixbmc.aurPackages == [ ]
      )
      "nixbmc.aurPackages must stay [] regardless of what's enabled -- it exists only for shape-consistency with nixdev/nixoffice"
    )

    # ── Arch/system-manager backend: no boot.kernelModules to reach, an assertion instead ───
    (check "arch: the module is disabled by default -- no failed assertions, no archPackages"
      (
        let
          c = evalArch { };
        in
        failedAssertionMessages c == [ ] && c.nixbmc.archPackages == [ ]
      )
      "expected zero failed assertions and nixbmc.archPackages == [] with nixbmc left entirely unconfigured"
    )

    (check "arch: ipmitool.enable with inBand left at its true default raises exactly one failed assertion"
      (
        let
          c = evalArch { enable = true; ipmitool.enable = true; };
        in
        lib.length (failedAssertionMessages c) == 1
      )
      "inBand = true (the default) cannot be honoured on a plane with no boot.kernelModules -- this must be a loud eval-time assertion failure, not a silent no-op"
    )

    (check "arch: ipmitool.enable with inBand = false raises no assertion and publishes archPackages == [ipmitool]"
      (
        let
          c = evalArch { enable = true; ipmitool = { enable = true; inBand = false; }; };
        in
        failedAssertionMessages c == [ ] && c.nixbmc.archPackages == [ "ipmitool" ]
      )
      "an out-of-band-only client is a valid shape on this backend -- expected zero failed assertions and archPackages == [\"ipmitool\"]"
    )

    (check "arch: flashrom.enable alone raises no assertion (the inBand assertion is gated on ipmitool.enable too) and publishes archPackages == [flashrom]"
      (
        let
          c = evalArch { enable = true; flashrom.enable = true; };
        in
        failedAssertionMessages c == [ ] && c.nixbmc.archPackages == [ "flashrom" ]
      )
      "flashrom never loads a kernel module on any backend, so it must never trip the ipmitool-only inBand assertion, and it must still publish archPackages"
    )

    (check "arch: nixbmc.enable = false with ipmitool.enable = true (top-level gate off) raises no assertion"
      (
        let
          c = evalArch { ipmitool.enable = true; };
        in
        failedAssertionMessages c == [ ]
      )
      "the assertion is gated on cfg.enable exactly like every other effect in this module -- the top-level gate must suppress it too, not just the package/kernel-module writes"
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
