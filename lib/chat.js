
// export async function sendChatMessage({
//   accessToken,
//   broadcasterId,
//   senderId,
//   message,
// }) {
//   const response = await fetch(
//     "https://api.twitch.tv/helix/chat/messages",
//     {
//       method: "POST",
//       headers: {
//         "Client-Id": process.env.TWITCH_CLIENT_ID,
//         Authorization: `Bearer ${accessToken}`,
//         "Content-Type": "application/json",
//       },
//       body: JSON.stringify({
//         broadcaster_id: broadcasterId,
//         sender_id: senderId,
//         message,
//       }),
//     },
//   );

//   const data = await response.json();

//   if (!response.ok || !data.data?.[0]?.is_sent) {
//     throw new Error(
//       data.message || "Failed to send Twitch chat message.",
//     );
//   }

//   return data.data[0];
// }
