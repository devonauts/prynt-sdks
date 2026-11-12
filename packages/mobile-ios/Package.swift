// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "Prynt",
    platforms: [.iOS(.v13)],
    products: [.library(name: "Prynt", targets: ["Prynt"])],
    targets: [.target(name: "Prynt", path: "Sources/Prynt")]
)
