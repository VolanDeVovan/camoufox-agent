{
  description = "camoufox-agent: a Camoufox browser for coding agents (MCP server)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # The browser build paired with the pinned `camoufox` launcher (package.json).
      # Each launcher release goes with one browser build; bump both together.
      browserVersion = "158.0.1-beta.41";
      browserAssets = {
        x86_64-linux = {
          asset = "lin.x86_64";
          sha256 = "3f2eb1d0451fa58e45e43e55f5e6181565069791ae60c0574f0ceb1f01341c33";
        };
      };

      # The browser as a fixed-output download, unpacked. It is a prebuilt, dynamically
      # linked Firefox: on NixOS it runs through nix-ld, as the launcher's own download does.
      camoufoxBrowser =
        pkgs:
        let
          asset =
            browserAssets.${pkgs.stdenv.hostPlatform.system}
              or (throw "camoufox-agent: no pinned Camoufox build for ${pkgs.stdenv.hostPlatform.system}; use the npm package, which downloads its own");
        in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "camoufox-browser";
          version = browserVersion;
          src = pkgs.fetchurl {
            url = "https://github.com/daijro/camoufox/releases/download/v${browserVersion}/camoufox-${browserVersion}-${asset.asset}.zip";
            inherit (asset) sha256;
          };
          nativeBuildInputs = [ pkgs.unzip ];
          dontConfigure = true;
          dontBuild = true;
          dontFixup = true;
          unpackPhase = "unzip -q $src -d browser";
          installPhase = ''
            mkdir -p $out
            cp -r browser/. $out/
            chmod -R u+w $out
            # The launcher reads the build's version from version.json beside the binary.
            [ -e $out/version.json ] || echo '{"version":"${nixpkgs.lib.head (nixpkgs.lib.splitString "-" browserVersion)}","build":"${nixpkgs.lib.concatStringsSep "-" (nixpkgs.lib.tail (nixpkgs.lib.splitString "-" browserVersion))}","interface":1}' > $out/version.json
            chmod +x $out/camoufox-bin $out/camoufox 2>/dev/null || true
          '';
        };

      package =
        pkgs:
        pkgs.stdenv.mkDerivation (finalAttrs: {
          pname = "camoufox-agent";
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          src = nixpkgs.lib.cleanSourceWith {
            src = ./.;
            filter =
              path: _type:
              !(builtins.elem (baseNameOf path) [
                "node_modules"
                "dist"
                "reference"
                "research"
                "test"
                "plan"
              ]);
          };

          nativeBuildInputs = [
            pkgs.nodejs_22
            pkgs.pnpm_10
            pkgs.pnpmConfigHook
            pkgs.makeWrapper
          ];

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            pnpm = pkgs.pnpm_10;
            fetcherVersion = 3;
            hash = "sha256-9lajUp2+/tT30PhUmo9FEnxGW7DMFMj2IWyhw4XvB8c=";
          };

          # The lockfile pins the versions; the `packageManager` field must not make pnpm fetch itself.
          env.npm_config_manage_package_manager_versions = "false";

          buildPhase = ''
            runHook preBuild
            pnpm build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/camoufox-agent $out/bin
            cp -r dist node_modules package.json README.md LICENSE $out/lib/camoufox-agent/
            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/camoufox-agent \
              --add-flags $out/lib/camoufox-agent/dist/mcp/server.js \
              --set-default CAMOUFOX_EXECUTABLE_PATH ${camoufoxBrowser pkgs}/camoufox-bin
            runHook postInstall
          '';

          meta = {
            description = "A Camoufox browser for coding agents: MCP server with persistent profiles";
            license = nixpkgs.lib.licenses.mit;
            mainProgram = "camoufox-agent";
          };
        });
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            pnpm
            sqlite
          ];
        };
      });

      # An extra way to install, never the only one: the npm package needs no Nix.
      packages = forAllSystems (pkgs: {
        default = package pkgs;
        browser = camoufoxBrowser pkgs;
      });
    };
}
