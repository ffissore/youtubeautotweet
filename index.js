require("dotenv").config()
const Bluebird = require("bluebird")
const { google } = require("googleapis")
const Twitter = require("twitter")
const Entities = require("html-entities").XmlEntities
const entities = new Entities()

const sources = require("./sources.json")

const twitter = new Twitter({
  consumer_key: process.env.TWITTER_CONSUMER_KEY,
  consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
  access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
  access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
})

const youtube = google.youtube({
  version: "v3",
  auth: process.env.YOUTUBE_API_KEY
})

const YOUTUBE_MAX_API_CALLS = 50
const TWITTER_MAX_API_CALLS = 100
const TWITTER_TIMELINE_MAX_TWEETS = 200
const ONE_HOUR = 1000 * 60 * 60

function youtubeURLToVideoId (url) {
  const idx = url.indexOf("v=") + 2
  return url.substring(idx)
}

function videoIdToYoutubeURL (videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`
}

async function fetchPostedVideoIdsFromTwitter (twitter) {
  const videos = []

  let maxId = null
  let timeline = []
  let rounds = 0
  do {
    const params = {
      screen_name: process.env.TWITTER_ACCOUNT_NAME,
      count: TWITTER_TIMELINE_MAX_TWEETS,
      trim_user: true,
      exclude_replies: true
    }
    if (maxId !== null) {
      params.max_id = maxId
    }
    timeline = await twitter.get("statuses/user_timeline", params)
    if (timeline.length > 0) {
      const latestId = timeline[timeline.length - 1].id
      if (latestId === maxId) {
        console.warn("Same tweet ID received, reached the end of the timeline")
        timeline.pop()
      }
      maxId = latestId
    }

    timeline
        .flatMap(tweet => tweet.entities.urls)
        .map(url => url.expanded_url)
        .map(youtubeURLToVideoId)
        .forEach(videoId => videos.push(videoId))

    rounds++
  } while (timeline.length > 0 && rounds < TWITTER_MAX_API_CALLS)

  return videos
}

async function fetchVideosFromYoutubeChannel (youtube, sourceChannel) {
  const videos = []

  let nextPageToken = null
  let rounds = 0
  do {
    const params = {
      part: "snippet",
      channelId: sourceChannel.id,
      type: "video",
      videoType: "any",
      maxResults: 50,
      pageToken: nextPageToken
    }
    const response = await youtube.search.list(params)
    nextPageToken = response.data.nextPageToken
    response.data.items.forEach(video => {
      video.twitter = sourceChannel.twitter
      videos.push(video)
    })
    rounds++
  } while (nextPageToken != null && rounds < YOUTUBE_MAX_API_CALLS)

  return videos
}

async function fetchVideoFromYoutubeId (youtube, sourceVideo) {
  const response = await youtube.videos.list({
    part: "snippet",
    id: sourceVideo.id
  })
  if (response.data.items.length === 0) {
    console.warn(`Video with id ${sourceVideo.id} not found`)
    return undefined
  }
  const video = response.data.items[0]
  video.twitter = sourceVideo.twitter
  return video
}

new Promise(async (resolve) => {
  const alreadyPostedVideoIds = await fetchPostedVideoIdsFromTwitter(twitter)

  const videosFromChannels = (await Bluebird.map(sources.channels, channel => {
    return fetchVideosFromYoutubeChannel(youtube, channel)
  })).flatMap(videos => videos)

  const videosFromIds = await Bluebird.map(sources.videos, video => {
    return fetchVideoFromYoutubeId(youtube, video)
  })

  const allVideos = []
  allVideos.push(...videosFromChannels)
  allVideos.push(...videosFromIds)

  const missingVideos = allVideos
      .filter(video => !alreadyPostedVideoIds.includes(video.id.videoId))
      //this is to give time to the video author to provide a meaningful title
      .filter(video => new Date() - new Date(video.snippet.publishedAt) > ONE_HOUR)
      .sort((v1, v2) => new Date(v1.snippet.publishedAt) - new Date(v2.snippet.publishedAt))

  await Bluebird.each(missingVideos, async video => {
    const videoId = video.id.videoId || video.id
    const videoTitle = entities.decode(video.snippet.title)

    const status = [ videoTitle ]
    if (video.twitter) {
      status.push(`@${video.twitter}`)
    }
    status.push(videoIdToYoutubeURL(videoId))

    const params = {
      status: status.join(" "),
      trim_user: true
    }
    await twitter.post("statuses/update", params)
    console.log(`Posted video id ${videoId}: ${videoTitle}`)

    // this is just to be nice with twitter
    await Bluebird.delay(1000)

    resolve()
  })
}).then(console.log).catch(console.log)
