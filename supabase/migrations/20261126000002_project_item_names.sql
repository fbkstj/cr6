-- 專題組評分項目名稱改成和 115 年初賽評分表（Word 檔）一致；只改還是舊預設名稱的項目，重跑不出錯。
update rubric_items set title = '應用及整合性' where title = '專題作品的應用及整合性';
update rubric_items set title = '主題與課程相關性' where title = '專題作品與課程相關';
update rubric_items set title = '創意性' where title = '創意性與實用性';
update rubric_items set title = '內文組織及架構格式' where title = '作品說明的組織與表達' and max_score = 10 and description like '試辦項目%';
