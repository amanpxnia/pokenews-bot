// Reads the text on a PSA slab's label (top part of the photo) with macOS's built-in Vision OCR.
// Usage: read_label <image-path>   → prints the recognized label lines, top to bottom.
import AppKit
import Vision

guard CommandLine.arguments.count > 1,
      let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("usage: read_label <image>\n".data(using: .utf8)!)
    exit(1)
}

// The PSA label sits in roughly the top 15% of the slab photo
let labelHeight = Int(Double(cg.height) * 0.15)
guard let label = cg.cropping(to: CGRect(x: 0, y: 0, width: cg.width, height: labelHeight)) else { exit(1) }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: label).perform([request])

let lines = (request.results ?? [])
    .sorted { $0.boundingBox.minY > $1.boundingBox.minY } // Vision's origin is bottom-left
    .compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\n"))
