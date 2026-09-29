// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Tenote",
    platforms: [.macOS("13.3")],
    products: [
        .executable(name: "Tenote", targets: ["Tenote"]),
        .executable(name: "tenotectl", targets: ["tenotectl"]),
    ],
    targets: [
        .target(name: "TenoteCore"),
        .executableTarget(name: "Tenote", dependencies: ["TenoteCore"]),
        .executableTarget(name: "tenotectl", dependencies: ["TenoteCore"]),
        .testTarget(name: "TenoteCoreTests", dependencies: ["TenoteCore"]),
    ]
)
