Target Warfare - Shop Mockup & Asset Guidelines

Overview
- These are developer-facing mockup guidelines and placeholders for product images and previews used in the in-app shop and fulfillment.

Required assets
1) Wordmark (wide) - replace assets/logo/target_warfare_wordmark.svg
   - Format: SVG (preferred) and PNG (transparent) at multiple sizes (1200x300, 600x150)
2) Mark (badge) - assets/logo/target_warfare_mark.svg
   - Format: SVG and PNG (square 400x400, 800x800)
3) Product mockups (mug / tumbler)
   - Flat wrap templates for tumbler: recommended final print size 4000x1400px @300DPI
   - Mug template: recommended final print size 3000x1000px @300DPI
   - Preview mockups (rendered): 1200x800 PNG for in-app preview
4) Placeholder sample images
   - Add high-quality example images under assets/mockups/

Naming conventions
- Use lowercase, hyphen-separated filenames, e.g. target-warfare-wordmark.svg
- Keep originals and provide "print-ready" and "preview" versions

How to replace
- Upload your real SVG/PNG files to the repo or to S3 and update the backend config (S3 path) to point to the assets.
- For local dev, commit the PNG/SVG into assets/logo/ and update Unity asset references.

Notes
- Provide transparent-background PNGs for overlay operations (logo on customer images)
- Provide a safe-area template for each product type so we can position logos and customer art correctly
