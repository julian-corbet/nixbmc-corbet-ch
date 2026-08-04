{
  description = "nixbmc — baseboard management controller (BMC) access, installed declaratively: ipmitool (in-band against this host's own BMC, the default, or an out-of-band-only client of a different machine's BMC with no kernel module) and/or flashrom, on NixOS and Arch/system-manager alike. No BMC IP, no credentials, no Redfish/remote client baked in, ever — an out-of-band caller supplies -H/-U/-P itself; not a virtual-media implementation. The planned clean-room browser-native KVM viewer for AMI MegaRAC-family BMCs (replacing the flaky bundled H5Viewer) is a separate, still-scaffold concern living in this same repo — see README.md's open questions.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = lib.genAttrs supportedSystems;
      pkgsFor = system: import nixpkgs { inherit system; };
    in
    {
      # Platform-neutral policy: the option surface and the resolved archPackages/aurPackages.
      # Import this directly if you want the lists and intend to wire them yourself.
      nixosModules.nixbmc = ./modules/nixbmc.nix;

      # NixOS backend — installs, via environment.systemPackages + boot.kernelModules.
      nixosModules.default = ./modules/nixos.nix;

      # nixosModules.kvm lands once the exposure-model and bare-metal-vs-k3s
      # questions in the README are settled — building the module before that
      # would bake in a guess about where it runs and how it's reached.

      # Arch / system-manager backend — publishes `nixbmc.archPackages`/`.aurPackages` for the
      # host's own pacman reconciler to consume. Installs nothing itself, and sets no
      # boot.kernelModules (that option doesn't exist on this plane) — see modules/arch.nix,
      # including why `ipmitool.inBand = true` there is an eval-time assertion, not a silent
      # override.
      systemManagerModules.nixbmc = ./modules/arch.nix;
      systemManagerModules.default = ./modules/arch.nix;

      lib = { };

      checks = forAllSystems (
        system:
        import ./checks {
          pkgs = pkgsFor system;
          inherit lib;
          nixosModule = self.nixosModules.default;
          archModule = self.systemManagerModules.default;
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixpkgs-fmt);
    };
}
