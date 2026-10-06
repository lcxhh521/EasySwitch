// EasySwitch's own minimal Security.framework bridge. One request per process.
// Credentials are passed over stdin/stdout, never process arguments or files.
import Foundation
import Security

struct Request: Decodable {
    let operation: String
    let account: String
    let value: String?
}

func reply(_ object: [String: Any]) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: []) {
        FileHandle.standardOutput.write(data)
    }
    exit(0)
}

// A bounded read prevents a malformed caller from asking the helper to buffer forever.
var input = Data()
while true {
    let chunk = FileHandle.standardInput.readData(ofLength: 8192)
    if chunk.isEmpty { break }
    input.append(chunk)
    if input.count > 1_048_576 { reply(["ok": false, "code": Int(errSecParam)]) }
}
guard let request = try? JSONDecoder().decode(Request.self, from: input),
      !request.account.isEmpty, request.account.count <= 1024 else {
    reply(["ok": false, "code": Int(errSecParam)])
}

// Keep the same service/account keys as the demo's security CLI implementation.
// Matching identifiers preserve lookup compatibility, but legacy ACL approval still belongs
// to the user. Background/launchd requests must fail promptly rather than opening UI.
let interaction = SecKeychainSetUserInteractionAllowed(false)
guard interaction == errSecSuccess else { reply(["ok": false, "code": Int(interaction)]) }
var defaultKeychain: SecKeychain?
let defaultStatus = SecKeychainCopyDefault(&defaultKeychain)
guard defaultStatus == errSecSuccess, defaultKeychain != nil else {
    reply(["ok": false, "code": Int(defaultStatus == errSecSuccess ? errSecNoDefaultKeychain : defaultStatus)])
}
// No default-keychain creation, unlock, ACL change, or fallback is attempted here.
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "EasySwitch",
    kSecAttrAccount as String: request.account,
]

switch request.operation {
case "get":
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecItemNotFound { reply(["ok": true, "found": false]) }
    guard status == errSecSuccess else { reply(["ok": false, "code": Int(status)]) }
    guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
        reply(["ok": false, "code": Int(errSecDecode)])
    }
    reply(["ok": true, "found": true, "value": value])
case "set":
    guard let value = request.value else { reply(["ok": false, "code": Int(errSecParam)]) }
    let attributes: [String: Any] = [kSecValueData as String: Data(value.utf8)]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
        var added = query
        added[kSecValueData as String] = Data(value.utf8)
        status = SecItemAdd(added as CFDictionary, nil)
    }
    if status == errSecSuccess { reply(["ok": true]) }
    reply(["ok": false, "code": Int(status)])
case "delete":
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecSuccess || status == errSecItemNotFound { reply(["ok": true]) }
    reply(["ok": false, "code": Int(status)])
default:
    reply(["ok": false, "code": Int(errSecParam)])
}
