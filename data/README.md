# Data

Training data (git-ignored; fetch with `python scripts/download_data.py`):

| File | Dataset | Rows |
|---|---|---|
| `raw/Tweets.csv` | Twitter US Airline Sentiment (Crowdflower, CC BY-NC-SA 4.0) | 14,640 |
| `raw/tweeteval_{train,validation,test}.csv` | TweetEval — sentiment (SemEval-2017; cardiffnlp/tweet_eval) | 59,899 |

Manual alternatives are listed in the docstring of `scripts/download_data.py`.
The trained model in `../models/` is committed, so the app runs without re-training.
