# Social sharing image

The existing KPi Travels share card is saved at `public/og.png`. `app/layout.tsx`
uses it for the favicon, Open Graph image and X/Twitter large-image card. It was
generated once with the built-in image tool, not through the application or its
AI provider. It contains no credentials or passenger data and does not affect the
booking interface.

Functional changes that do not alter the brand, title or public description do
not require regenerating this asset.

Final prompt:

> Use case: ads-marketing. Asset type: landscape social sharing image for a bus
> booking website. Create exactly one restrained, clean sharing card for KPi
> Travels, approximately 1.91:1 landscape aspect ratio. Flat cream background
> (#f6f8f5), ample negative space. Refined minimal graphic design with elegant,
> highly legible typography and a simple small bus-and-road motif. Dominant brand
> name with supporting line below, generous safe margins, subtle compact bus/road
> illustration that never competes with the wording. Cream (#f6f8f5) and forest
> green (#23644c) only. Text exactly: "KPi Travels". Supporting text exactly:
> "Your next journey, one booking away." Preserve capitalization exactly: uppercase
> K, uppercase P, lowercase i, space, Travels. Render both lines crisply and
> legibly. No extra text, people, private data, watermark, or mockup frame. Single
> finished landscape image.
