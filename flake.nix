{
  description = "nixbmc — local baseboard management controller (BMC) access as a NixOS module: ipmitool (+ the in-band IPMI kernel interface) and/or flashrom, installed declaratively. In-band (KCS/SSIF) only — no BMC IP, no credentials, no Redfish/remote client, not a virtual-media implementation. The planned clean-room browser-native KVM viewer for AMI MegaRAC-family BMCs (replacing the flaky bundled H5Viewer) is a separate, still-scaffold concern living in this same repo — see README.md's open questions.";

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
      nixosModules.nixbmc = ./modules/default.nix;
      nixosModules.default = self.nixosModules.nixbmc;

      # nixosModules.kvm lands once the exposure-model and bare-metal-vs-k3s
      # questions in the README are settled — building the module before that
      # would bake in a guess about where it runs and how it's reached.

      lib = { };

      checks = forAllSystems (
        system:
        import ./checks {
          pkgs = pkgsFor system;
          inherit lib;
          nixbmcModule = self.nixosModules.nixbmc;
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixpkgs-fmt);
    };
}
