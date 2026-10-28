import Foundation

/// Injectable decoder makes the decoded-pixel ceiling testable without UIKit.
public enum ShareImagePreparation {
    public static let maximumEdge = 4096
    public static let jpegQuality = 0.85
    public static func prepare(source: URL, destination: URL,
                               thumbnail: (URL, URL, Int, Double) throws -> Void) throws {
        try thumbnail(source, destination, maximumEdge, jpegQuality)
        try ShareFiles.excludeFromBackup(destination)
    }
}

#if canImport(ImageIO) && canImport(UniformTypeIdentifiers)
import ImageIO
import UniformTypeIdentifiers

extension ShareImagePreparation {
    public static func prepare(source: URL, destination: URL, expectedType: String) throws {
        try prepare(source: source, destination: destination, expectedType: expectedType,
                    thumbnail: CGImageSourceCreateThumbnailAtIndex)
    }
    static func prepare(source: URL, destination: URL, expectedType: String,
                        thumbnail: (CGImageSource, Int, CFDictionary?) -> CGImage?) throws {
        try prepare(source: source, destination: destination) { source, destination, edge, quality in
            try autoreleasepool {
                guard let image = CGImageSourceCreateWithURL(source as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
                      let actual = CGImageSourceGetType(image) as String?,
                      actual == expectedType || (Set(["public.heic", "public.heif"]).contains(actual) && Set(["public.heic", "public.heif"]).contains(expectedType)),
                      let preview = thumbnail(image, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceThumbnailMaxPixelSize: edge,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceShouldCacheImmediately: true
                      ] as CFDictionary),
                      let output = CGImageDestinationCreateWithURL(destination as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
                    throw ShareInputError.unsupported
                }
                CGImageDestinationAddImage(output, preview, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
                guard CGImageDestinationFinalize(output) else { throw ShareInputError.invalid }
            }
        }
    }
}
#endif
