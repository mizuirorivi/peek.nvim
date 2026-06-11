local config = require('peek.config')

local chansend = vim.fn.chansend
local concat = table.concat
local tbl_map = vim.tbl_map

local module = {}

local cwd = debug.getinfo(1, 'S').source:sub(2):match('(.*[/\\])')
local cmd, channel

local function lentouint32(str)
  local len = string.len(str)
  local t = {}
  for i = 4, 1, -1 do
    t[i] = math.fmod(len, 256)
    len = math.floor((len - t[i]) / 256)
  end
  return string.char(unpack(t))
end

local function message(chunks)
  return concat(tbl_map(function(chunk)
    return lentouint32(chunk) .. chunk
  end, chunks))
end

function module.setup()
  local sep = vim.loop.os_uname().sysname:match('Windows') and '\\' or '/'
  local args = {
    '--logfile=' .. string.format('%s%speek.log', vim.fn.stdpath('log'), sep),
    '--theme=' .. config.get('theme'),
    '--app=' .. vim.json.encode(config.get('app')),
  }

  if config.get('syntax') then
    table.insert(args, '--syntax')
  end

  if config.get('useful_web') then
    table.insert(args, '--useful-web')
  end

  cmd = vim.list_extend({
    'deno',
    'task',
    '--quiet',
    'run',
  }, args)
end

function module.init(on_exit, on_open_file, on_listdir)
  if channel then
    return
  end

  channel = vim.fn.jobstart(cmd, {
    cwd = cwd,
    stderr_buffered = true,
    on_stdout = function(_, data)
      for _, line in ipairs(data) do
        if line ~= '' then
          local ok, msg = pcall(vim.json.decode, line)
          if ok and type(msg) == 'table' and msg.path then
            if msg.action == 'open' then
              vim.schedule(function()
                if on_open_file and vim.fn.filereadable(msg.path) == 1 then
                  on_open_file(msg.path)
                end
              end)
            elseif msg.action == 'listdir' then
              vim.schedule(function()
                if on_listdir then
                  if vim.fn.isdirectory(msg.path) == 1 then
                    on_listdir(msg.path)
                  else
                    module.dirlist(msg.path, {})
                  end
                end
              end)
            end
          end
        end
      end
    end,
    on_stderr = function(_, err)
      vim.fn.jobstop(channel)
      local content = table.concat(err, '\n'):gsub('\27[[0-9;]*m', '')
      if content:len() > 0 then
        if content:match("assertion 'main_loops != NULL' failed") then
          return
        end
        vim.api.nvim_notify('Peek error: ' .. content, vim.log.levels.ERROR, {})
      end
    end,
    on_exit = function()
      vim.fn.chanclose(channel)
      channel = nil
      on_exit()
    end,
  })

  module.show = function(content)
    chansend(channel, message({ 'show', content }))
  end

  module.scroll = function(line)
    chansend(channel, message({ 'scroll', line }))
  end

  module.base = function(path)
    chansend(channel, message({ 'base', path }))
  end

  module.dirlist = function(path, entries)
    chansend(channel, message({ 'dirlist', vim.json.encode({ path = path, entries = entries }) }))
  end
end

module.stop = function()
  if channel then
    vim.fn.jobstop(channel)
  end
end

return module
