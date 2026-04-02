// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "ClaudeWorkspace",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(
            name: "ClaudeWorkspace",
            targets: ["ClaudeWorkspace"]
        )
    ],
    targets: [
        .executableTarget(
            name: "ClaudeWorkspace",
            resources: [
                .copy("Resources")
            ]
        ),
        .testTarget(
            name: "ClaudeWorkspaceTests",
            dependencies: ["ClaudeWorkspace"]
        )
    ]
)
