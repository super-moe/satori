import { Bot, Context, h, Session, Universal } from '@satorijs/satori'
import * as QQ from './types'
import { QQBot } from './bot'
import { unescape } from '@satorijs/element'

export const decodeGuild = (guild: QQ.Guild): Universal.Guild => ({
  id: guild.id,
  name: guild.name,
})

export const decodeChannel = (channel: QQ.Channel): Universal.Channel => ({
  id: channel.id,
  name: channel.name,
  // TODO support more channel types
  type: Universal.Channel.Type.TEXT,
})

export const decodeUser = (user: QQ.User): Universal.User => ({
  id: user.id,
  name: user.username,
  isBot: user.bot,
  avatar: user.avatar,
})

export const decodeGuildMember = (member: QQ.Member): Universal.GuildMember => ({
  user: decodeUser(member.user),
  nick: member.nick,
  roles: member.roles,
})

export function decodeGroupMessage(
  bot: QQBot,
  data: QQ.UserMessage,
  message: Universal.Message = {},
  payload: Universal.MessageLike = message,
) {
  message.id = data.id
  const date = data.timestamp.slice(0, data.timestamp.indexOf('m=')).trim().replace(/\+(\d{4}) CST/, 'GMT+$1')
  message.timestamp = new Date(date).valueOf()
  message.elements = []
  if (data.content.length) message.elements.push(h.text(data.content))
  for (const attachment of (data.attachments ?? [])) {
    if (attachment.content_type === 'file') {
      message.elements.push(h.file(attachment.url, {
        filename: attachment.filename,
      }))
    } else if (attachment.content_type.startsWith('image/')) {
      message.elements.push(h.image(attachment.url))
    } else if (attachment.content_type === 'voice') {
      message.elements.push(h.audio(attachment.url))
    } else if (attachment.content_type === 'video') {
      message.elements.push(h.video(attachment.url))
    }
  }

  message.guild = { id: data.group_id }
  message.user = { id: data.author.id }
  return message
}

export async function decodeMessage(
  bot: Bot,
  data: QQ.Message,
  message: Universal.Message = {},
  payload: Universal.MessageLike = message,
): Promise<Universal.Message> {
  message.id = message.messageId = data.id
  message.content = (data.content ?? '')
    .replace(/<@!(\d+)>/g, (_, $1) => h.at($1).toString())
  // .replace(/<#(.+)>/, (_, $1) => h.sharp($1).toString()) // not used?
  const { attachments = [] } = data
  if (attachments.length && !/\s$/.test(message.content)) message.content += ' '
  message.content = attachments
    .filter(({ content_type }) => content_type.startsWith('image'))
    .reduce((content, attachment) => content + h.image('https://' + attachment.url), message.content)
  message.elements = h.parse(message.content)
  message.elements = h.transform(message.elements, {
    text: (attrs) => unescape(attrs.content),
  })

  if (data.message_reference) {
    message.quote = bot.getMessage
      ? await bot.getMessage(data.channel_id, data.message_reference.message_id)
      : { id: data.message_reference.message_id }
  }

  if (!payload) return message
  payload.timestamp = new Date(data.timestamp).valueOf()
  payload.user = decodeUser(data.author)
  if (data.direct_message) {
    // real guild id, dm's fake guild id
    payload.guild = { id: `${data.src_guild_id}_${data.guild_id}` }
    payload.channel = { id: `${data.guild_id}_${data.channel_id}`, type: Universal.Channel.Type.DIRECT }
  } else {
    payload.guild = { id: data.guild_id }
    payload.channel = { id: data.channel_id, type: Universal.Channel.Type.TEXT }
  }
  return message
}

export function setupReaction(session: Session, data: QQ.MessageReaction) {
  session.userId = data.user_id
  session.guildId = data.guild_id
  session.channelId = data.channel_id
  session.content = `${data.emoji.type}:${data.emoji.id}`
  // https://bot.q.qq.com/wiki/develop/api/openapi/reaction/model.html#reactiontargettype
  session.messageId = data.target.id
  session.isDirect = false
  return session
}

export async function adaptSession<C extends Context = Context>(bot: QQBot<C>, input: QQ.DispatchPayload) {
  let session = bot.session()

  if (!['GROUP_AT_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE', 'FRIEND_ADD', 'FRIEND_DEL',
    'GROUP_ADD_ROBOT', 'GROUP_DEL_ROBOT', 'INTERACTION_CREATE'].includes(input.t)) {
    session = bot.guildBot.session()
  }

  session.setInternal('qq', input)
  if (input.t === 'MESSAGE_CREATE' || input.t === 'AT_MESSAGE_CREATE' || input.t === 'DIRECT_MESSAGE_CREATE') {
    if (bot.config.type === 'private' && input.t === 'AT_MESSAGE_CREATE' && bot.config.intents & QQ.Intents.GUILD_MESSAGES) return
    session.type = 'message'
    await decodeMessage(bot, input.d, session.event.message = {}, session.event)
  } else if (input.t === 'MESSAGE_REACTION_ADD') {
    if (input.d.target.type !== 'ReactionTargetType_MSG') return
    setupReaction(session, input.d)
    session.type = 'reaction-added'
  } else if (input.t === 'MESSAGE_REACTION_REMOVE') {
    if (input.d.target.type !== 'ReactionTargetType_MSG') return
    setupReaction(session, input.d)
    session.type = 'reaction-removed'
  } else if (input.t === 'CHANNEL_CREATE' || input.t === 'CHANNEL_UPDATE' || input.t === 'CHANNEL_DELETE') {
    session.type = {
      CHANNEL_CREATE: 'channel-added',
      CHANNEL_UPDATE: 'channel-updated',
      CHANNEL_DELETE: 'channel-deleted',
    }[input.t]
    session.guildId = input.d.guild_id
    session.event.channel = decodeChannel(input.d)
  } else if (input.t === 'GUILD_CREATE' || input.t === 'GUILD_UPDATE' || input.t === 'GUILD_DELETE') {
    session.type = {
      GUILD_CREATE: 'guild-added',
      GUILD_UPDATE: 'guild-updated',
      GUILD_DELETE: 'guild-deleted',
    }[input.t]
    session.event.guild = decodeGuild(input.d)
  } else if (input.t === 'DIRECT_MESSAGE_DELETE' || input.t === 'MESSAGE_DELETE' || input.t === 'PUBLIC_MESSAGE_DELETE') {
    if (bot.config.type === 'private' && input.t === 'PUBLIC_MESSAGE_DELETE' && bot.config.intents & QQ.Intents.GUILD_MESSAGES) return
    session.type = 'message-deleted'
    session.userId = input.d.message.author.id
    session.operatorId = input.d.op_user.id
    session.messageId = input.d.message.id
    session.isDirect = input.d.message.direct_message
    if (session.isDirect) {
      session.guildId = `${input.d.message.src_guild_id}_${input.d.message.guild_id}`
      session.channelId = `${input.d.message.guild_id}_${input.d.message.channel_id}`
    } else {
      session.guildId = input.d.message.guild_id
      session.channelId = input.d.message.channel_id
    }
  } else if (input.t === 'GROUP_AT_MESSAGE_CREATE') {
    session.type = 'message'
    session.isDirect = false
    decodeGroupMessage(bot, input.d, session.event.message = {}, session.event)
    session.guildId = session.event.message.guild.id
    session.channelId = session.guildId
    session.userId = session.event.message.user.id
    session.elements.unshift(h.at(session.selfId))
  } else if (input.t === 'C2C_MESSAGE_CREATE') {
    session.type = 'message'
    session.isDirect = true
    decodeGroupMessage(bot, input.d, session.event.message = {}, session.event)
    session.userId = input.d.author.id
    session.channelId = session.userId
  } else if (input.t === 'FRIEND_ADD') {
    session.type = 'friend-added'
    session.timestamp = input.d.timestamp
    session.userId = input.d.openid
  } else if (input.t === 'FRIEND_DEL') {
    session.type = 'friend-added'
    session.timestamp = input.d.timestamp
    session.userId = input.d.openid
  } else if (input.t === 'GROUP_ADD_ROBOT') {
    session.type = 'guild-added'
    session.timestamp = input.d.timestamp
    session.guildId = input.d.group_openid
    session.operatorId = input.d.op_member_openid
  } else if (input.t === 'GROUP_DEL_ROBOT') {
    session.type = 'guild-removed'
    session.timestamp = input.d.timestamp
    session.guildId = input.d.group_openid
    session.operatorId = input.d.op_member_openid
  } else if (input.t === 'INTERACTION_CREATE') {
    session.type = 'interaction/button'
    session.userId = input.d.group_member_openid ?? input.d.data.resolved.user_id
    if (input.d.chat_type === QQ.ChatType.GROUP) {
      session.guildId = input.d.group_openid
      session.channelId = input.d.group_openid
      session.isDirect = false
    } else if (input.d.chat_type === QQ.ChatType.CHANNEL) {
      session.channelId = input.d.channel_id
      session.isDirect = false // ?
    } else if (input.d.chat_type === QQ.ChatType.DIRECT) {
      session.isDirect = true
      session.channelId = session.userId
    }
    session.event.button = {
      id: input.d.data.resolved.button_id,
    }
    // session.messageId = input.d.id // event_id is not supported for sending message

    // {message: 'get header appid failed', code: 630006}
    try {
      await bot.internal.acknowledgeInteraction(input.d.id, 0)
    } catch (e) {
      bot.logger.warn(e)
    }
  } else {
    return
  }
  return session
}
