# Paint Ithaca fonts

`Fraunces.ttf` is a static derivative of Fraunces by The Fraunces Project Authors, copyright 2018. It is renamed **Paint Ithaca Serif**, PostScript name **PaintIthacaSerif-Regular**. Its fixed axes are `wght=400`, `opsz=30`, `SOFT=0`, `WONK=1`; it is used for the 24–30 pt display headings. The original copyright and license metadata remain embedded; `Fraunces-OFL.txt` contains the unchanged SIL Open Font License 1.1.

Source: [official Google Fonts Fraunces](https://raw.githubusercontent.com/google/fonts/main/ofl/fraunces/Fraunces%5BSOFT%2CWONK%2Copsz%2Cwght%5D.ttf), downloaded September 16, 2026. Original SHA-256: `177ff6c0f14e5550a3c624247cd1189611d4eb65d000b14944c63d967958abbb`. Static derivative SHA-256: `ae87be6f3dfaaddc927c128ec2bfbcce374d5a4986486ee3915b7926c279faa2`.

`DMSans.ttf` is the unmodified variable DM Sans font by The DM Sans Project Authors, copyright 2014. PostScript name: **DMSans-9ptRegular**. Source: [official Google Fonts DM Sans](https://raw.githubusercontent.com/google/fonts/main/ofl/dmsans/DMSans%5Bopsz%2Cwght%5D.ttf). Its unchanged license is `DMSans-OFL.txt`.

## Reproduce the serif instance

Use fontTools 4.65.0. Download the Fraunces source above to a temporary file, check its SHA-256, and run `instantiateVariableFont(TTFont(source), {"wght": 400, "opsz": 30, "SOFT": 0, "WONK": 1}, inplace=True)`. Replace name IDs 1/16 with `Paint Ithaca Serif`, 2/17 with `Regular`, 4 with `Paint Ithaca Serif Regular`, 6 with `PaintIthacaSerif-Regular`, 25 with `PaintIthacaSerif`, and 3 with `1.000;PITH;PaintIthacaSerif-Regular;opsz30wght400` in every existing encoding and Windows English (platform 3, encoding 1, language 0x409). Keep copyright, designer, and license names intact. Set `OS/2.usWeightClass=400`, clear italic/bold bits and set the regular bit in `OS/2.fsSelection`, clear bold/italic bits in `head.macStyle`, remove `STAT` and `DSIG` if present, and save as `Fraunces.ttf`.

SwiftUI: `Font.custom("PaintIthacaSerif-Regular", size: size)`. No runtime variation code or weight override is required.
