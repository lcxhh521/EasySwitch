# Preparing the Mac application

The application package contains its own Node runtime and the EasySwitch core. End users should not need a separate Node installation. Development with `node core/src/main.ts` remains available.

The current packaging workflow can run in the cloud after native Mac inputs have been supplied. The cloud tests use explicitly labelled structural fixtures. They do not produce an installable application or verify real Mac behaviour.

## Required inputs

- A compiled EasySwitch menu bar executable for the selected architecture
- The native Keychain helper, already signed with the existing stable signing identity
- A native input manifest generated on a Mac by `scripts/prepare-macos-inputs.ts`
- The unmodified official Node archive listed in `packaging/node-runtime.json`

Node is pinned to 24.21.0 LTS, separately for arm64 and x64. The builder checks the archive's exact SHA-256 before reading it and keeps the complete runtime LICENSE. It copies Node itself, not npm or package-install scripts. Node 24's official binaries require macOS 13.5 or later, so that is also the application minimum.

Sources: [official release](https://nodejs.org/en/blog/release/v24.21.0), [published checksums](https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt), [supported platforms](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md#supported-platforms), [runtime notices](https://github.com/nodejs/node/blob/v24.21.0/LICENSE).

## Verify native inputs on a Mac

After compiling the menu bar and preparing the existing stably signed Keychain helper, run:

```sh
node scripts/prepare-macos-inputs.ts arm64 /path/to/EasySwitch /path/to/easyswitch-keychain /path/to/new-native-inputs.json
```

Use `x64` for an Intel build. The command checks architecture, the helper's designated identity and its existing signature, then records exact binary hashes. It does not compile, sign, create a certificate, read a key or change Keychain permissions. Existing output files are not overwritten.

An unsigned or ad-hoc helper is rejected. Temporarily signing the outer app does not establish the helper's stable Keychain access identity. The cloud builder checks structural signature evidence and the supplied manifest; it cannot independently perform Apple's signature validation.

## Assemble the app and archive

```sh
node scripts/package-macos.ts --source /path/to/EasySwitch --output /path/to/empty-output --arch arm64 --node-archive /path/to/node-v24.21.0-darwin-arm64.tar.gz --menubar /path/to/EasySwitch --keychain-helper /path/to/easyswitch-keychain --native-manifest /path/to/new-native-inputs.json
```

The builder downloads and executes nothing. It requires explicit input paths and refuses existing output names. A failed validation does not create a package. The result is an unsigned `EasySwitch.app` and a ZIP preserving executable permissions.

The bundle uses paths relative to its Resources directory:

- `node/bin/node`: the pinned runtime
- `app/core/src/app-supervisor.ts`: the supervised entrypoint
- `app/core/src/main.ts`: the core service
- `app/bin/es.ts`: the command-line interface
- `app/core/src/user-cli-install.ts`: the explicit command installer
- `app/core/native/build/easyswitch-keychain`: the supplied native helper

The official application and menu bar icon bytes are copied unchanged from `menubar/Resources`. The bundle records application/runtime versions, architecture and input hashes in `runtime-manifest.json`. No developer checkout or local Node path is baked into Info.plist.

## Runtime behaviour

The menu bar owns its supervisor through a pipe. Closing that pipe stops the owned core. The supervisor uses a short increasing retry delay after unexpected exits and stops after five consecutive retries. A stable thirty-second run resets that history. Shutdown first requests graceful termination, then escalates after six seconds to allow owned tasks to finish their bounded cleanup; if exit is still unconfirmed, it reports a failure. It never terminates a process merely because that process holds EasySwitch's port or has an EasySwitch-looking command line. The menu reports issued connection records, not a guessed running-process count. “Back to native” stops only its owned core after an explicit confirmation; existing interactive client windows must be closed by the user. A nonzero or unconfirmed core or supervisor shutdown does not count as a successful application quit.

If the supervisor itself disappears, the core wrapper notices its ownership pipe closing and begins bounded shutdown. Data remains under `~/Library/Application Support/EasySwitch`. No automatic data migration or deletion is performed.

Opening at login is off by default. Registering a login item must follow an explicit user action and reflect macOS's actual approval state. See Apple's [main-app login item API](https://developer.apple.com/documentation/servicemanagement/smappservice/mainapp).

“Install es command” writes a small wrapper to `~/.local/bin/es` only after the user selects that action. It uses the app's own Node runtime, quotes app paths containing spaces, and refuses to overwrite another command or follow a linked command directory. It does not edit shell profiles or PATH. If installation is unavailable, the app can offer an alias to copy into the current terminal. Moving or deleting the app can invalidate the installed wrapper.

## Remaining Mac acceptance

No signing, notarization, login-item installation or real Mac application execution was performed during cloud implementation. Before distribution:

1. Build current native inputs for each supported architecture and verify the helper's existing stable identity
2. Assemble the real package, then confirm the included Node version on that Mac
3. Apply the agreed temporary outer-app signature without re-signing the helper ad-hoc, verify the entire bundle, and create a new archive of the signed result
4. Decide separately whether to use an Apple Developer account for distribution signing and notarization; neither is automatic
5. On a fresh Mac, download the archive, drag the app into Applications, open it and finish the first-run wizard
6. Verify crash restart, normal quit, menu bar crash, port conflict, login default-off and explicit approval, and command installation with both a clean directory and an existing unrelated `es`
7. Confirm normal Claude, Codex and other agent configurations still behave as before

A structurally valid bundle or passing fake process test does not replace these checks.
