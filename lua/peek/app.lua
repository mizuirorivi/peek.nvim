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

  if config.get('sync_scroll_from_browser') then
    table.insert(args, '--sync-scroll')
  end

  cmd = vim.list_extend({
    'deno',
    'task',
    '--quiet',
    'run',
  }, args)
end

function module.init(on_exit, on_open_file, on_listdir, on_scroll, on_select_tab, on_source, on_render)
  if channel then
    return
  end

  local stdout_buffer = ''

  channel = vim.fn.jobstart(cmd, {
    cwd = cwd,
    stderr_buffered = true,
    on_stdout = function(_, data)
      if not data or #data == 0 then
        return
      end
      data[1] = stdout_buffer .. data[1]
      stdout_buffer = table.remove(data) or ''

      for _, line in ipairs(data) do
        if line ~= '' then
          local ok, msg = pcall(vim.json.decode, line)
          if ok and type(msg) == 'table' then
            if msg.action == 'scroll' then
              local scroll_line = tonumber(msg.line)
              local document_id = tonumber(msg.documentId)
              local version = tonumber(msg.version)
              if
                on_scroll
                and scroll_line
                and scroll_line >= 1
                and scroll_line == math.floor(scroll_line)
                and document_id
                and document_id >= 1
                and document_id == math.floor(document_id)
                and version
                and version >= 0
                and version == math.floor(version)
              then
                vim.schedule(function()
                  on_scroll(scroll_line, document_id, version)
                end)
              end
            elseif msg.action == 'source' then
              local source_line = tonumber(msg.line)
              local document_id = tonumber(msg.documentId)
              local version = tonumber(msg.version)
              if
                on_source
                and source_line
                and source_line >= 1
                and source_line == math.floor(source_line)
                and document_id
                and document_id >= 1
                and document_id == math.floor(document_id)
                and version
                and version >= 0
                and version == math.floor(version)
              then
                vim.schedule(function()
                  on_source(source_line, document_id, version)
                end)
              end
            elseif msg.action == 'selecttab' then
              local tab_id = tonumber(msg.tabId)
              if on_select_tab and tab_id and tab_id >= 1 and tab_id == math.floor(tab_id) then
                vim.schedule(function()
                  on_select_tab(tab_id)
                end)
              end
            elseif msg.action == 'render' then
              local document_id = tonumber(msg.documentId)
              local version = tonumber(msg.version)
              if
                on_render
                and document_id
                and document_id >= 1
                and document_id == math.floor(document_id)
                and type(msg.documentKey) == 'string'
                and version
                and version >= 0
                and version == math.floor(version)
              then
                local document_key = msg.documentKey
                vim.schedule(function()
                  on_render(document_id, document_key, version)
                end)
              end
            elseif msg.action == 'open' and type(msg.path) == 'string' then
              local path = msg.path
              local open_in_tab
              if type(msg.tab) == 'boolean' then
                open_in_tab = msg.tab
              end
              local document_id = tonumber(msg.documentId)
              local version = tonumber(msg.version)
              local fragment
              if type(msg.fragment) == 'string' then
                fragment = msg.fragment
              end
              vim.schedule(function()
                if
                  on_open_file
                  and document_id
                  and document_id >= 1
                  and document_id == math.floor(document_id)
                  and version
                  and version >= 0
                  and version == math.floor(version)
                  and vim.fn.filereadable(path) == 1
                then
                  local ok, err = pcall(on_open_file, path, open_in_tab, document_id, version, fragment)
                  if not ok then
                    vim.notify('Peek link error: ' .. tostring(err), vim.log.levels.ERROR)
                  end
                end
              end)
            elseif msg.action == 'listdir' and msg.path then
              local path = msg.path
              vim.schedule(function()
                if on_listdir then
                  if vim.fn.isdirectory(path) == 1 then
                    on_listdir(path)
                  else
                    module.dirlist(path, {})
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

  module.show = function(document_id, document_key, version, content)
    chansend(
      channel,
      message({
        'show',
        tostring(document_id),
        document_key,
        tostring(version),
        content,
      })
    )
  end

  module.restore = function(document_id, document_key, version)
    chansend(channel, message({ 'restore', tostring(document_id), document_key, tostring(version) }))
  end

  module.updating = function(document_id, document_key, version)
    chansend(
      channel,
      message({
        'updating',
        tostring(document_id),
        document_key,
        tostring(version),
      })
    )
  end

  module.scroll = function(document_id, document_key, version, line)
    chansend(
      channel,
      message({
        'scroll',
        tostring(document_id),
        document_key,
        tostring(version),
        tostring(line),
      })
    )
  end

  module.base = function(path)
    chansend(channel, message({ 'base', path }))
  end

  module.document = function(document_id, document_key, version, path)
    chansend(
      channel,
      message({
        'document',
        tostring(document_id),
        document_key,
        tostring(version),
        path,
      })
    )
  end

  module.tabs = function(tabs)
    chansend(channel, message({ 'tabs', vim.json.encode(tabs) }))
  end

  module.navigate = function(document_id, document_key, version, fragment)
    chansend(
      channel,
      message({
        'navigate',
        tostring(document_id),
        document_key,
        tostring(version),
        fragment,
      })
    )
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
