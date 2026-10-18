-- 论道话题。一篇最多 3 个，用来把不同主题从道论里分开。

CREATE TABLE post_tags (
  post_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (post_id, tag),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

CREATE INDEX post_tags_tag ON post_tags (tag, post_id);
