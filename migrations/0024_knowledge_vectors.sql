-- 知識チャンネルのファイルの中を、意味で探せるようにする(#96 の3つ目のPR)
-- 仕様: architecture.md「知識チャンネル」

-- 文字にした内容を区切って入れたベクトルの数(Vectorize。IDは k<ファイルのID>-<区切りの番号>)。
-- まだベクトルにしていなければNULL。ファイルを消すときに、ベクトルも消すのに使う
ALTER TABLE knowledge_files ADD COLUMN vector_count INTEGER;
