UPDATE posts SET channel = 'wenjin' WHERE channel = 'wendao';
UPDATE posts SET channel = 'jishi' WHERE channel = 'tianji';
UPDATE posts SET channel = 'xuanbang' WHERE channel = 'xuanshang';
UPDATE posts SET channel = 'shidao' WHERE channel = 'shilian';

UPDATE channels SET slug = 'wenjin' WHERE slug = 'wendao';
UPDATE channels SET slug = 'jishi' WHERE slug = 'tianji';
UPDATE channels SET slug = 'xuanbang' WHERE slug = 'xuanshang';
UPDATE channels SET slug = 'shidao' WHERE slug = 'shilian';
