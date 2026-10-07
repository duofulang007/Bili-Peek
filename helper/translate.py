"""Translate timestamped subtitle rows; input/output are JSON, original text stays intact."""
import json, pathlib, sys

def main():
    raw = sys.stdin.buffer.read(1000001)
    if len(raw) > 1000000:
        raise ValueError('Subtitle text exceeds the translation size limit')
    payload = json.loads(raw.decode('utf-8'))
    texts = payload.get('texts')
    if not isinstance(texts, list) or not 0 < len(texts) <= 3000 or any(not isinstance(t, str) or not t.strip() or len(t) > 6000 for t in texts):
        raise ValueError('Invalid subtitle text')
    import ctranslate2
    import sentencepiece
    root = pathlib.Path(sys.argv[1])
    metadata = json.loads((root / 'metadata.json').read_text('utf-8'))
    if metadata.get('from_code') != 'en' or metadata.get('to_code') != 'zh':
        raise ValueError('Expected English-to-Chinese model')
    tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(root / 'sentencepiece.model'))
    tokens = [tokenizer.encode(text, out_type=str) for text in texts]
    if any(len(row) > 512 for row in tokens):
        raise ValueError('Subtitle paragraph is too long; split it before translation')
    translator = ctranslate2.Translator(str(root / 'model'), device='cpu', compute_type='int8', intra_threads=2, inter_threads=1)
    result = []
    for start in range(0, len(tokens), 16):
        batch = translator.translate_batch(tokens[start:start + 16], beam_size=2, replace_unknowns=True, max_decoding_length=512, length_penalty=0.2)
        result.extend(tokenizer.decode(item.hypotheses[0]).strip() for item in batch)
    if len(result) != len(texts) or any(not text for text in result):
        raise ValueError('Incomplete translation; original subtitles retained')
    print(json.dumps({'engine': 'Argos/CTranslate2', 'direction': 'en-zh', 'texts': result}, ensure_ascii=False))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
