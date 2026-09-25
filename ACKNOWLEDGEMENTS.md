Acknowledgements
================

Faceclaw is an open source project, at https://github.com/jimrandomh/faceclaw.
Contributors include:
    James Babcock <jimrandomh@gmail.com>
    Kalani Helekunihi <i@am.guru>


Many thanks to g2-kit-unofficial: https://github.com/Commute773/g2-kit-unofficial/,
evenRealities-openCFW https://github.com/kalanihelekunihi/evenRealities-openCFW/,
and others who contributed to documenting the G2's bluetooth protocol and firmware.

G2 microphone LC3 decoding uses Google's liblc3: https://github.com/google/liblc3

On-device speech recognition uses sherpa-onnx by k2-fsa:
https://github.com/k2-fsa/sherpa-onnx (Apache License 2.0). The speech models
are not bundled; each is downloaded when you choose it in Settings > Voice:

- NVIDIA Parakeet TDT 0.6B v2 (https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2)
  and NVIDIA Parakeet TDT_CTC 110M (https://huggingface.co/nvidia/parakeet-tdt_ctc-110m),
  created by NVIDIA and licensed under the Creative Commons Attribution 4.0
  International License: https://creativecommons.org/licenses/by/4.0/
  The files Faceclaw downloads are modified versions: the sherpa-onnx project
  exported them to ONNX and quantized them to int8. They are offered as-is,
  without warranties of any kind (see the license's Section 5).
- OpenAI Whisper base.en (https://github.com/openai/whisper), MIT License,
  Copyright (c) 2022 OpenAI; exported to ONNX and quantized by sherpa-onnx.
- Moonshine Base by Useful Sensors, Inc. (https://github.com/moonshine-ai/moonshine),
  MIT License; converted for sherpa-onnx by the sherpa-onnx project.
- SenseVoice Small by Alibaba Group's FunAudioLLM team
  (https://github.com/FunAudioLLM/SenseVoice, model weights
  https://huggingface.co/FunAudioLLM/SenseVoiceSmall), used for Japanese,
  Korean and Chinese captions in the Microphones app (downloaded there, not in
  Settings > Voice). Licensed under the FunASR Model Open Source License
  Agreement: https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE
  The files Faceclaw downloads were exported to ONNX and quantized to int8 by
  the sherpa-onnx project (sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17).

The Terminus font is by Dimitar Zhekov's Terminus: https://framagit.org/ohnonot/terv-terc
and is distributed under the SIL Open Font License; see app/fonts/terminus/LICENSE.

The TerminusV proportional font is by ohnonot, derived from Terminus:
https://framagit.org/ohnonot/terv-terc. It is also distributed under the SIL
Open Font License; see app/fonts/terminusv/LICENSE.

The CJK font is Source Han Sans SC Light by Adobe:
https://github.com/adobe-fonts/source-han-sans. It is distributed under the SIL
Open Font License, Version 1.1; see app/fonts/source-han-sans/LICENSE.txt.
Faceclaw includes the G2's serialized 20 px LVGL build of the font so
phone-side rendering matches the glasses.
