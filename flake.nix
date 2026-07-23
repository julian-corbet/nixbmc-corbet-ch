{
  description = "nixbmc — a clean-room, browser-native replacement for AMI MegaRAC's flaky H5Viewer KVM (pre-alpha scaffold, no module yet — see README's open questions)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
      ];
    in
    {
      lib = { };

      # nixosModules.kvm lands once the exposure-model and bare-metal-vs-k3s
      # questions in the README are settled — building the module before that
      # would bake in a guess about where it runs and how it's reached.

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixpkgs-fmt);
    };
}
